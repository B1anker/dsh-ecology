import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import { cloneTree } from '../../src/fs/clone.js'
import { sha256Hex } from '../../src/fs/hash.js'
import { artifactCleanup, artifactInventory } from '../../src/lab/artifacts.js'
import { assertCoreRows, parseComposedTreeText, runComposeProbe } from '../../src/lab/compose.js'
import { idempotent } from '../../src/web/idempotency.js'
import { type Investigation, nextTrial } from '../../src/workflows/bisect.js'
import { parsePortable } from '../../src/workflows/portable.js'

const ctx = (home: string) => ({
  home,
  profileName: 'web',
  cwd: home,
  env: {},
  json: true,
  breakStaleLock: false,
  now: () => new Date(),
})
test('durable duplicate submissions execute once and reject conflicting payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wl-request-'))
  let count = 0
  try {
    const body = { action: 'test', requestId: '0123456789abcdef' }
    const run = async () => {
      count++
      return { jobId: 'job-fixture' }
    }
    const values = await Promise.all([
      idempotent(ctx(root), body, run),
      idempotent(ctx(root), body, run),
    ])
    expect(values[0]).toEqual(values[1])
    await idempotent(ctx(root), body, run)
    expect(count).toBe(1)
    await expect(idempotent(ctx(root), { ...body, value: 2 }, run)).rejects.toThrow('冲突')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
const session = (kind: 'time' | 'plugins'): Investigation => ({
  version: 1,
  id: 'bisect-fixture',
  profile: 'web',
  sourceId: 'origin',
  kind,
  createdAt: '',
  revision: 0,
  baseline: 's7',
  snapshots: Array.from({ length: 8 }, (_, i) => `s${i}`),
  plugins: ['a', 'b', 'c', 'd'],
  trials: [],
  status: 'ready',
  candidates: [],
  note: '',
  granularity: 2,
})
test('time bisect rechecks both endpoints then identifies first bad snapshot', () => {
  const s = session('time')
  for (let i = 0; i < 20; i++) {
    const trial = nextTrial(s)
    if (!trial) break
    trial.verdict = Number(trial.snapshotId!.slice(1)) >= 5 ? 'bad' : 'good'
    s.trials.push(trial)
  }
  expect(s.trials.slice(0, 2).map((t) => t.snapshotId)).toEqual(['s0', 's7'])
  expect(s.candidates).toEqual(['s5'])
  expect(s.status).toBe('complete')
})
test('time bisect preserves uncertainty around skipped snapshots', () => {
  const s = session('time')
  for (let i = 0; i < 20; i++) {
    const trial = nextTrial(s)
    if (!trial) break
    trial.verdict = trial.snapshotId === 's0' ? 'good' : trial.snapshotId === 's7' ? 'bad' : 'skip'
    s.trials.push(trial)
  }
  expect(s.status).toBe('inconclusive')
  expect(s.candidates.length).toBe(7)
})
test('plugin reduction retains interacting pairs instead of blaming one plugin', () => {
  const s = session('plugins')
  for (let i = 0; i < 100; i++) {
    const trial = nextTrial(s)
    if (!trial) break
    trial.verdict = trial.plugins!.includes('b') && trial.plugins!.includes('d') ? 'bad' : 'good'
    s.trials.push(trial)
  }
  expect(s.status).toBe('complete')
  expect(s.candidates.sort()).toEqual(['b', 'd'])
})
test('a broken core-only endpoint cannot blame optional plugins', () => {
  const s = session('plugins')
  for (let i = 0; i < 3; i++) {
    const t = nextTrial(s)
    if (t) {
      t.verdict = 'bad'
      s.trials.push(t)
    }
  }
  expect(s.status).toBe('inconclusive')
})
function bundle(path = 'package.json') {
  const data = Buffer.from('{}')
  return {
    format: 'world-line-environment',
    version: 1,
    profile: 'web',
    files: [{ path, data: data.toString('base64'), sha256: sha256Hex(data), executable: false }],
    requiredFiles: [],
    vendors: [],
  }
}
test('portable import rejects traversal, duplicate files and hash mismatch', () => {
  expect(() => parsePortable(JSON.stringify(bundle('../outside')))).toThrow('路径')
  const value = bundle()
  value.files.push(value.files[0]!)
  expect(() => parsePortable(JSON.stringify(value))).toThrow('重复')
  const bad = bundle()
  bad.files[0]!.sha256 = 'bad'
  expect(() => parsePortable(JSON.stringify(bad))).toThrow('哈希')
  expect(parsePortable(JSON.stringify(bundle())).files.length).toBe(1)
})
test('CoW clone produces independent writable files and refuses external links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wl-clone-'))
  try {
    await mkdir(join(root, 'source'))
    await writeFile(join(root, 'source', 'file'), 'original')
    await cloneTree(join(root, 'source'), join(root, 'copy'))
    expect((await stat(join(root, 'source', 'file'))).ino).not.toBe(
      (await stat(join(root, 'copy', 'file'))).ino,
    )
    await writeFile(join(root, 'copy', 'file'), 'modified')
    expect(await readFile(join(root, 'source', 'file'), 'utf8')).toBe('original')
    await symlink('/outside', join(root, 'source', 'link'))
    await expect(cloneTree(join(root, 'source'), join(root, 'another'))).rejects.toThrow('外部')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('artifact retention keeps newest, rejects stale previews and ignores corrupt captures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wl-artifact-policy-'))
  try {
    for (let i = 0; i < 3; i++) {
      const dir = join(root, `probe-${i}-abc`)
      await mkdir(dir)
      await writeFile(join(dir, 'failure.png'), 'png')
      await writeFile(
        join(dir, 'index.json'),
        JSON.stringify({
          version: 1,
          private: true,
          createdAt: new Date(i * 1000).toISOString(),
          files: ['failure.png'],
        }),
      )
    }
    await mkdir(join(root, 'probe-corrupt'))
    await writeFile(join(root, 'probe-corrupt', 'index.json'), 'bad')
    expect((await artifactInventory(root)).length).toBe(3)
    const p = await artifactCleanup(root)
    expect(p.candidates.length).toBe(2)
    await expect(artifactCleanup(root, true, 'wrong')).rejects.toThrow('变化')
    await artifactCleanup(root, true, p.revision)
    expect((await artifactInventory(root)).length).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('runtime compose guard fails when a trusted core row is disabled', async () => {
  const base = parseComposedTreeText('# == core\n- id: required\n', 'baseline')
  const result = await runComposeProbe({
    dshBinary: 'fixture',
    profileName: 'web',
    env: {},
    cwd: '/tmp',
    coreCheck: async (candidate) => assertCoreRows(candidate, base, new Set(['core'])),
    run: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      spawnError: null,
      stdout: '# == core\n- id: required\n  disabled: true\n',
      stderr: '',
    }),
  })
  expect(result.probes.some((p) => p.label === '核心模板完整性' && p.status === 'fail')).toBe(true)
})

test('deployment switches atomically and failed boots revert to a different verified slot', async () => {
  const { deploymentRoot, activateDeployment, activeSlot, recordBootResult, deploymentStatus } =
    await import('../../src/workflows/deployment.js')
  const root = await mkdtemp(join(tmpdir(), 'wl-deployment-')),
    context = ctx(root)
  const a = 'slot-11111111-1111-1111-1111-111111111111',
    b = 'slot-22222222-2222-2222-2222-222222222222'
  try {
    for (const id of [a, b]) {
      const directory = join(deploymentRoot(context), id)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'slot.json'),
        JSON.stringify({ version: 1, id, profile: 'web', verified: true }),
      )
    }
    await activateDeployment(context, a)
    await recordBootResult(context, a, true)
    await activateDeployment(context, b)
    expect(await activeSlot(context)).toBe(b)
    await recordBootResult(context, b, false, 'fixture')
    await recordBootResult(context, b, false, 'fixture')
    expect(await activeSlot(context)).toBe(b)
    expect(await recordBootResult(context, b, false, 'fixture')).toMatchObject({
      rolledBack: true,
      active: a,
    })
    expect((await deploymentStatus(context)).enabled).toBe(false)
    await expect(activateDeployment(context, '../escape')).rejects.toThrow('无效')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deployment pointer remains whole across real process interruption at both switch boundaries', async () => {
  const { spawnSync } = await import('node:child_process')
  const { deploymentRoot, activateDeployment, activeSlot } = await import(
    '../../src/workflows/deployment.js'
  )
  const root = await mkdtemp(join(tmpdir(), 'wl-deployment-kill-')),
    context = ctx(root)
  const a = 'slot-11111111-1111-1111-1111-111111111111',
    b = 'slot-22222222-2222-2222-2222-222222222222'
  try {
    for (const id of [a, b]) {
      const directory = join(deploymentRoot(context), id)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'slot.json'),
        JSON.stringify({ version: 1, id, profile: 'web', verified: true }),
      )
    }
    await activateDeployment(context, a)
    const moduleUrl = new URL('../../dist/workflows/deployment.js', import.meta.url).href
    for (const boundary of ['decision', 'pointer']) {
      const code = `import {activateDeployment} from ${JSON.stringify(moduleUrl)};const ctx=${JSON.stringify({ ...context, breakStaleLock: true })};ctx.now=()=>new Date();await activateDeployment(ctx,${JSON.stringify(b)},async phase=>{if(phase===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL')})`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        timeout: 15000,
      })
      expect(result.signal).toBe('SIGKILL')
      expect(await activeSlot(context)).toBe(boundary === 'decision' ? a : b)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cache cleanup cannot race an active validation lease', async () => {
  const { withPackageCache, prunePackageCache } = await import('../../src/lab/cache-maintenance.js')
  const root = await mkdtemp(join(tmpdir(), 'wl-cache-lease-'))
  try {
    await withPackageCache(root, async () => {
      await expect(prunePackageCache(ctx(root), true)).rejects.toThrow('租约')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('portable import rejects absolute local paths even when archive paths are safe', () => {
  const value = bundle(),
    bytes = Buffer.from(JSON.stringify({ dependencies: { plugin: 'file:/private/source' } }))
  value.files[0]!.data = bytes.toString('base64')
  value.files[0]!.sha256 = sha256Hex(bytes)
  expect(() => parsePortable(JSON.stringify(value))).toThrow('bundled sources')
})

test('lockfile rewriting preserves registry integrity while relocating local packages', async () => {
  const { rewriteLocalLock } = await import('../../src/lab/vendor.js')
  const original = {
    importers: {
      '.': {
        dependencies: { local: { specifier: 'file:../plugin', version: 'file:../plugin(peer@1)' } },
      },
    },
    packages: {
      'local@file:../plugin': { resolution: { directory: '../plugin', type: 'directory' } },
      'remote@1.0.0': { resolution: { integrity: 'sha512-unchanged' } },
    },
  }
  const result = rewriteLocalLock(original, '/env/profile', [
    { name: 'local', target: '/env/plugin', spec: 'file:/bundle/plugin' },
  ]) as any
  expect(result.importers['.'].dependencies.local.version).toBe('file:/bundle/plugin(peer@1)')
  expect(result.packages['local@file:/bundle/plugin'].resolution.directory).toBe('/bundle/plugin')
  expect(result.packages['remote@1.0.0']).toEqual(original.packages['remote@1.0.0'])
})

test('package names do not masquerade as sensitive keys, while real credentials remain detected', async () => {
  const { detectSecretShapes } = await import('../../src/domain/redaction.js')
  expect(detectSecretShapes('google-auth-library: 10.9.1\n')).toEqual([])
  expect(detectSecretShapes('auth-token: private-value\n').length).toBeGreaterThan(0)
})

test('upgrade results stay scoped to the selected profile', async () => {
  const { upgradeResults } = await import('../../src/workflows/upgrades.js')
  const root = await mkdtemp(join(tmpdir(), 'wl-upgrade-profile-'))
  try {
    const dir = join(root, 'world-line/upgrade-results')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'job-a.json'), JSON.stringify({ profile: 'web', rows: [] }))
    await writeFile(
      join(dir, 'job-b.json'),
      JSON.stringify({ profile: 'other', rows: [{ name: 'private' }] }),
    )
    expect(await upgradeResults(ctx(root))).toEqual([{ profile: 'web', rows: [] }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('new Web workflows expose scoped reads and reject invalid mutations before side effects', async () => {
  const { operate } = await import('../../src/web/index.js')
  const root = await mkdtemp(join(tmpdir(), 'wl-workflow-api-'))
  try {
    await mkdir(join(root, 'profiles/web'), { recursive: true })
    await writeFile(join(root, 'profiles/web/package.json'), '{}')
    expect(await operate(ctx(root), { action: 'investigations' })).toEqual([])
    expect(await operate(ctx(root), { action: 'upgrade-results' })).toEqual([])
    expect(((await operate(ctx(root), { action: 'deployment-status' })) as any).active).toBe(null)
    expect(
      ((await operate(ctx(root), { action: 'upgrade-policy', id: 'origin' })) as any).enabled,
    ).toBe(false)
    expect(
      ((await operate(ctx(root), { action: 'recovery-list', id: 'origin' })) as any).swaps,
    ).toEqual([])
    await expect(
      operate(ctx(root), { action: 'deployment-config', enabled: true, threshold: '0' }),
    ).rejects.toThrow('1–10')
    await expect(
      operate(ctx(root), { action: 'deployment-activate', id: '../../bad' }),
    ).rejects.toThrow()
    await expect(
      operate(ctx(root), {
        action: 'investigation-answer',
        id: '../../bad',
        revision: '1',
        verdict: 'good',
      }),
    ).rejects.toThrow()
    await expect(
      operate(ctx(root), { action: 'environment-export', id: 'origin', snapshotId: '../../bad' }),
    ).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upgrade suggestions respect SemVer and never propose a downgrade', async () => {
  const { isNewerVersion } = await import('../../src/workflows/upgrades.js')
  expect(isNewerVersion('0.1.1', '0.1.2-rc.1')).toBe(false)
  expect(isNewerVersion('0.1.2', '0.1.2-rc.1')).toBe(true)
  expect(isNewerVersion('1.0.0-rc.10', '1.0.0-rc.2')).toBe(true)
  expect(isNewerVersion('1.0.0-alpha', '1.0.0')).toBe(false)
  expect(isNewerVersion('2.0.0', undefined)).toBe(false)
})
