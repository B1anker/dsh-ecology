import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { runSnapshotCreate } from '../../src/commands/snapshot.js'
import { detectDrift } from '../../src/domain/drift.js'
import { analyzeProfile } from '../../src/domain/snapshot.js'
import { profileLockPath, snapshotManifestPath, statePath } from '../../src/fs/paths.js'
import { adapterDsh01x } from '../../src/host-adapters/dsh-0.1.x.js'
import { noteLastKnownGood, readState } from '../../src/vault/state.js'
import { destroyTempHome, makeTempHome, writeProfile } from '../helpers/fixture.js'

async function setup() {
  const home = await makeTempHome()
  const dir = await writeProfile(home, 'web')
  const ctx = {
    home,
    profileName: 'web',
    cwd: home,
    env: { ...process.env, WORLD_LINE_DISABLE_KEYCHAIN: '1' },
    json: false,
    breakStaleLock: false,
    now: () => new Date(),
  }
  const analyze = () => analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
  return { home, dir, ctx, analyze }
}
describe('read-only drift', () => {
  test('local source edits are detected even when package declarations stay unchanged', async () => {
    const { home, dir, ctx, analyze } = await setup()
    try {
      const plugin = join(home, 'plugin')
      await mkdir(plugin)
      await writeFile(
        join(plugin, 'package.json'),
        JSON.stringify({ name: 'fixture-local', version: '1.0.0' }),
      )
      await writeFile(join(plugin, 'index.js'), 'export const value = 1')
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      pkg.dependencies['fixture-local'] = 'file:../../plugin'
      await writeFile(join(dir, 'package.json'), JSON.stringify(pkg))
      await runSnapshotCreate(ctx, { label: null })
      expect((await detectDrift(home, 'web', await analyze())).latest.status).toBe('same')
      await writeFile(join(plugin, 'index.js'), 'export const value = 2')
      const result = await detectDrift(home, 'web', await analyze())
      expect(result.latest.status).toBe('changed')
      expect(result.latest.changedFiles).toContain('local-source:fixture-local')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('missing baselines stay missing without creating state', async () => {
    const { home, analyze } = await setup()
    try {
      const result = await detectDrift(home, 'web', await analyze())
      expect(result.latest.status).toBe('missing')
      expect(result.lastKnownGood.status).toBe('missing')
      await expect(readFile(statePath(home))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await destroyTempHome(home)
    }
  })
  test('latest record and verified stable point remain independent', async () => {
    const { home, dir, ctx, analyze } = await setup()
    try {
      const first = await runSnapshotCreate(ctx, { label: null })
      await noteLastKnownGood(home, 'web', first.id)
      await writeFile(
        join(dir, 'package.json'),
        (await readFile(join(dir, 'package.json'), 'utf8')) + '\n',
      )
      const second = await runSnapshotCreate(ctx, { label: null })
      const before = await readState(home)
      const result = await detectDrift(home, 'web', await analyze())
      expect(result.latest).toMatchObject({ snapshotId: second.id, status: 'same' })
      expect(result.lastKnownGood).toMatchObject({
        snapshotId: first.id,
        status: 'changed',
        changedFiles: ['package.json'],
      })
      expect(await readState(home)).toEqual(before)
      await writeFile(join(home, 'cordis.patch.yml'), '- id: home-change\n')
      expect((await detectDrift(home, 'web', await analyze())).latest.changedFiles).toContain(
        'home/cordis.patch.yml',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
  test('corrupt baseline and concurrent changes never report unchanged', async () => {
    const { home, dir, ctx, analyze } = await setup()
    try {
      const snapshot = await runSnapshotCreate(ctx, { label: null })
      await writeFile(snapshotManifestPath(home, snapshot.id), 'invalid json')
      expect((await detectDrift(home, 'web', await analyze())).latest.status).toBe('unknown')
      const staleAnalysis = await analyze()
      await writeFile(join(dir, 'package.json'), '{}')
      expect((await detectDrift(home, 'web', staleAnalysis)).note).toContain('读取期间')
      await mkdir(dirname(profileLockPath(home, 'web')), { recursive: true })
      await writeFile(profileLockPath(home, 'web'), '{}')
      expect((await detectDrift(home, 'web', await analyze())).latest.status).toBe('unknown')
    } finally {
      await destroyTempHome(home)
    }
  })
})
