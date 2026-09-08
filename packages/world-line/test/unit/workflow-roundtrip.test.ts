import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, rs, test } from '@rstest/core'
import { runSnapshotCreate } from '../../src/commands/snapshot.js'
import { versionMatrix } from '../../src/workflows/compatibility.js'
import { exportEnvironment, importEnvironment } from '../../src/workflows/portable.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

const { capture, verify } = rs.hoisted(() => ({ capture: rs.fn(), verify: rs.fn() }))
rs.mock('../../src/lab/runner.js', () => ({ runCaptured: capture }))
rs.mock('../../src/lab/run.js', () => ({ runLabTransaction: verify }))
const handle = {
  id: 'job-roundtrip',
  kind: 'environment-import' as const,
  setPhase: rs.fn(),
  pushProbe: rs.fn(),
  setLabId: rs.fn(),
  setTransactionId: rs.fn(),
}
test('portable local plugin round trip preserves sources and configuration while keeping the target isolated', async () => {
  const home = await makeTempHome()
  try {
    const bin = await installFakeDsh(home)
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: { PATH: bin },
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const local = join(home, 'local')
    await mkdir(local)
    await writeFile(
      join(local, 'package.json'),
      JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }),
    )
    await writeFile(join(local, 'index.js'), 'export const value=1\n', { mode: 0o755 })
    await writeFile(join(local, '.env'), 'PRIVATE=excluded\n')
    const original = JSON.stringify({
      private: true,
      dependencies: { 'fixture-plugin': `file:${local}` },
    })
    const profile = await writeProfile(home, 'web', {
      packageJson: original,
      patchYaml: '- id: example\n  config:\n    path: ' + home + '/data\n',
    })
    await mkdir(join(profile, 'node_modules/fixture-plugin'), { recursive: true })
    await writeFile(
      join(profile, 'node_modules/fixture-plugin/package.json'),
      JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }),
    )
    const snapshot = await runSnapshotCreate(ctx, { label: 'portable' })
    const bundle = await exportEnvironment(ctx, snapshot.id)
    expect(bundle.vendors[0]?.files.some((f) => f.path === '.env')).toBe(false)
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE=excluded')
    capture.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      spawnError: null,
      timedOut: false,
    })
    verify.mockImplementation(async (input) => {
      expect(input.ctx.home).toBe(home)
      expect(input.clientProbes).toBe(true)
      return { ok: true, clientReady: 'passed' }
    })
    const imported = await importEnvironment(ctx, JSON.stringify(bundle), 'origin', {}, handle)
    expect(imported.ok).toBe(true)
    const target = join(home, 'world-line/labs', imported.labId, 'home/profiles/web')
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    expect(pkg.dependencies['fixture-plugin']).toContain('/world-line/imports/')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(original)
    expect(await readFile(join(target, 'cordis.patch.yml'), 'utf8')).toContain(imported.labId)
    capture.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'install failure',
      spawnError: null,
      timedOut: false,
    })
    await expect(importEnvironment(ctx, JSON.stringify(bundle))).rejects.toThrow('安装失败')
    await expect(
      importEnvironment(ctx, JSON.stringify({ ...bundle, profile: 'other' })),
    ).rejects.toThrow('profile')
    await expect(
      importEnvironment(ctx, JSON.stringify({ ...bundle, requiredFiles: ['cordis.patch.yml'] })),
    ).rejects.toThrow('补充')
    await writeFile(join(local, 'index.js'), 'changed')
    await expect(exportEnvironment(ctx, snapshot.id)).rejects.toThrow('与快照不一致')
  } finally {
    await destroyTempHome(home)
  }
})
test('version matrix verifies exact host executables, records failures and never marks a trial promotable', async () => {
  const home = await makeTempHome()
  try {
    const bin = await installFakeDsh(home)
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeProfile(home, 'web')
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: { PATH: bin },
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    capture.mockImplementation(async (_binary, _args, options) => {
      const pkg = JSON.parse(await readFile(join(options.cwd, 'package.json'), 'utf8'))
      const version = pkg.dependencies['@deepseek-ai/dsh']
      await mkdir(join(options.cwd, 'node_modules/.bin'), { recursive: true })
      await writeFile(join(options.cwd, 'node_modules/.bin/dsh'), `#!/bin/sh\necho ${version}\n`, {
        mode: 0o755,
      })
      return { exitCode: 0, stdout: '', stderr: '', spawnError: null, timedOut: false }
    })
    verify.mockResolvedValue({ ok: true, clientReady: 'passed' })
    const result = await versionMatrix(ctx, ['0.1.2-rc.1', '0.1.2-rc.1'], 'origin', handle)
    expect(result.rows.length).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.rows[0]?.promotable).toBe(false)
    capture.mockResolvedValue({ exitCode: 1 })
    expect((await versionMatrix(ctx, ['0.1.3'], 'origin', handle)).ok).toBe(false)
    await expect(versionMatrix(ctx, ['latest'], 'origin', handle)).rejects.toThrow('精确')
  } finally {
    await destroyTempHome(home)
  }
})
