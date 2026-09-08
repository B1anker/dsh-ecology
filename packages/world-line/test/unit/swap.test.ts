import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from '@rstest/core'
import { withOperations } from '../../src/fs/operation.js'
import { pendingSwaps, recoverFileSwap, transactionalReplaceFiles } from '../../src/lab/swap.js'
import { runCliIn, writeProfile } from '../helpers/fixture.js'

const hash = (value: string | null) =>
  value === null ? null : createHash('sha256').update(value).digest('hex')
const id = '.wl-staging-012345abcdef'
const changes = [
  { name: 'package.json', before: 'old package', after: 'new package' },
  { name: 'pnpm-lock.yaml', before: null, after: 'new lock' },
  { name: 'cordis.patch.yml', before: 'old patch', after: null },
]
async function fixture(applied: number, state = 'prepared') {
  const dir = await mkdtemp(join(tmpdir(), 'wl-swap-'))
  const staging = join(dir, id)
  await mkdir(join(staging, 'backup'), { recursive: true })
  for (const [index, file] of changes.entries()) {
    if (file.before !== null) await writeFile(join(staging, 'backup', file.name), file.before)
    const current = index < applied ? file.after : file.before
    if (current !== null) await writeFile(join(dir, file.name), current)
  }
  await writeFile(
    join(staging, 'record.json'),
    JSON.stringify({
      version: 1,
      state,
      files: changes.map((file) => ({
        name: file.name,
        before: hash(file.before),
        after: hash(file.after),
      })),
    }),
  )
  return dir
}
async function assertOriginal(dir: string) {
  expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('old package')
  expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('old patch')
  expect((await readdir(dir)).includes('pnpm-lock.yaml')).toBe(false)
}

describe('durable managed-file swaps', () => {
  test('commit fsync failure reports uncertainty and never claims rollback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-swap-fsync-'))
    try {
      await writeFile(join(dir, 'package.json'), 'old package')
      const script = `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        const original = fs.open;
        fs.open = async (...args) => {
          const handle = await original(...args);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            if (String(args[0]).match(/\\.wl-staging-[a-f0-9]{12}$/)) {
              const record = await fs.readFile(join(args[0], 'record.json'), 'utf8').catch(() => '{}');
              if (JSON.parse(record).state === 'committed') throw new Error('injected directory fsync failure');
            }
            return sync();
          };
          return handle;
        };
        syncBuiltinESMExports();
        const { transactionalReplaceFiles } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/lab/swap.js')).href)});
        try { await transactionalReplaceFiles(${JSON.stringify(dir)}, ['package.json'], async () => 'new package'); }
        catch (error) { console.log(error.message); }
      `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 10000,
      })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stdout).toContain('commit durability uncertain')
      expect(child.stdout).not.toContain('rolled back')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('new package')
      const pending = await pendingSwaps(dir)
      expect(pending).toHaveLength(1)
      expect(await recoverFileSwap(dir, pending[0]!)).toEqual({ outcome: 'committed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('CLI lists and recovers explicitly, while writers and snapshots refuse pending state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wl-recovery-cli-'))
    try {
      const dir = await writeProfile(home, 'web')
      const before = await readFile(join(dir, 'package.json'), 'utf8')
      await mkdir(join(dir, id, 'backup'), { recursive: true })
      await writeFile(join(dir, id, 'backup', 'package.json'), before)
      await writeFile(
        join(dir, id, 'record.json'),
        JSON.stringify({
          version: 1,
          state: 'prepared',
          files: [{ name: 'package.json', before: hash(before), after: hash('candidate') }],
        }),
      )
      await writeFile(join(dir, 'package.json'), 'candidate')
      const listed = await runCliIn({ home, argv: ['--json', 'recovery', 'list'] })
      expect(listed.exitCode).toBe(0)
      expect(listed.stdout).toContain(id)
      await expect(withOperations([home], 'web', async () => 'must not execute')).rejects.toThrow(
        'unfinished',
      )
      const snapshot = await runCliIn({ home, argv: ['snapshot', 'create'] })
      expect(snapshot.exitCode).toBe(2)
      expect(snapshot.stderr).toContain('unfinished')
      const unconfirmed = await runCliIn({ home, argv: ['recovery', 'rollback', id] })
      expect(unconfirmed.exitCode).toBe(2)
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('candidate')
      const recovered = await runCliIn({
        home,
        argv: ['--json', 'recovery', 'rollback', id, '--yes'],
      })
      expect(recovered.exitCode, recovered.stderr).toBe(0)
      expect(recovered.stdout).toContain('rolled-back')
      expect(recovered.stdout).toContain('"runtimeVerified": false')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  for (const stopAfter of [1, 2])
    test(`SIGKILL after replacement ${stopAfter} leaves recoverable bytes`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wl-swap-kill-'))
      try {
        await writeFile(join(dir, 'package.json'), 'old package')
        await writeFile(join(dir, 'cordis.patch.yml'), 'old patch')
        const script = `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        import { dirname } from 'node:path';
        const original = fs.rename;
        let replaced = 0;
        fs.rename = async (...args) => {
          await original(...args);
          if (dirname(args[1]) === ${JSON.stringify(dir)} && ++replaced === ${stopAfter})
            process.kill(process.pid, 'SIGKILL');
        };
        syncBuiltinESMExports();
        const { transactionalReplaceFiles } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/lab/swap.js')).href)});
        const changes = ${JSON.stringify(changes)};
        await transactionalReplaceFiles(${JSON.stringify(dir)}, changes.map(f => f.name), async name => changes.find(f => f.name === name).after);
      `
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(child.signal, child.stderr).toBe('SIGKILL')
        const pending = await pendingSwaps(dir)
        expect(pending).toHaveLength(1)
        await recoverFileSwap(dir, pending[0]!)
        await assertOriginal(dir)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  for (const count of [0, 1, 2, 3])
    test(`recovers process exit after ${count} replacements`, async () => {
      const dir = await fixture(count)
      try {
        expect(await pendingSwaps(dir)).toEqual([id])
        await expect(
          transactionalReplaceFiles(dir, ['package.json'], async () => 'another'),
        ).rejects.toThrow('unfinished')
        expect(await recoverFileSwap(dir, id)).toEqual({ outcome: 'rolled-back' })
        await assertOriginal(dir)
        expect(await pendingSwaps(dir)).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  test('checks every file before restoring and preserves backups on external edits', async () => {
    const dir = await fixture(3)
    try {
      await writeFile(join(dir, 'cordis.patch.yml'), 'user edit')
      await expect(recoverFileSwap(dir, id)).rejects.toThrow('conflict')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('new package')
      expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe('user edit')
      expect(await pendingSwaps(dir)).toEqual([id])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('damaged backups fail closed without touching the profile', async () => {
    const dir = await fixture(3)
    try {
      await writeFile(join(dir, id, 'backup', 'cordis.patch.yml'), 'corrupt')
      await expect(recoverFileSwap(dir, id)).rejects.toThrow('damaged')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('new package')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('resumes an interrupted recovery with mixed original/candidate files', async () => {
    const dir = await fixture(3)
    try {
      await writeFile(join(dir, 'package.json'), 'old package')
      await recoverFileSwap(dir, id)
      await assertOriginal(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('a durable commit only finishes cleanup, preserving subsequent user edits', async () => {
    const dir = await fixture(3, 'committed')
    try {
      await writeFile(join(dir, 'package.json'), 'user edit')
      expect(await recoverFileSwap(dir, id)).toEqual({ outcome: 'committed' })
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('user edit')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('refuses backup symlinks', async () => {
    const dir = await fixture(1)
    try {
      await rm(join(dir, id, 'backup'), { recursive: true })
      await symlink(dir, join(dir, id, 'backup'))
      await expect(recoverFileSwap(dir, id)).rejects.toThrow('backup directory')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('new package')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('successful swap replaces/adds/deletes and keeps new file bytes private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-swap-'))
    try {
      await writeFile(join(dir, 'package.json'), 'old')
      await writeFile(join(dir, 'cordis.patch.yml'), 'delete')
      await transactionalReplaceFiles(
        dir,
        changes.map((file) => file.name),
        async (name) => changes.find((file) => file.name === name)!.after,
      )
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('new package')
      expect((await stat(join(dir, 'package.json'))).mode & 0o777).toBe(0o600)
      expect((await readdir(dir)).sort()).toEqual(['package.json', 'pnpm-lock.yaml'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test('preparation failure leaves original bytes untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-swap-'))
    try {
      await writeFile(join(dir, 'package.json'), 'old')
      await expect(
        transactionalReplaceFiles(dir, ['package.json'], async () => {
          throw new Error('source unavailable')
        }),
      ).rejects.toThrow('rolled back')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('old')
      expect(await pendingSwaps(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
