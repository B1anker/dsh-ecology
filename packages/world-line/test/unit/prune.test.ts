/**
 * Time-Machine retention prune tests (Phase 4 §7): dry-run planning never
 * removes files, lastKnownGood pins and parent chains survive, only the
 * current profile's snapshots are pruned, and `--yes` deletes manifest +
 * secret bundle of the planned set.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import { runTimelinePrune } from '../../src/commands/timeline.js'
import type { CliContext } from '../../src/context.js'
import type { SnapshotManifest } from '../../src/domain/snapshot.js'
import { destroyTempHome, makeTempHome, runCliIn } from '../helpers/fixture.js'

function manifestOf(id: string, createdAt: string, parentId: string | null): SnapshotManifest {
  return {
    formatVersion: 1,
    kind: 'profile-snapshot',
    id,
    createdAt,
    label: null,
    parentId,
    action: 'snapshot',
    candidateSource: null,
    validation: null,
    retention: null,
    createdBy: {
      worldLineVersion: '0.1.0',
      environment: { node: 'v24', os: 'x', arch: 'y' },
    },
    dsh: { cliVersion: '0.1.2-rc.1', known: true, adapterId: 'dsh-0.1.x' },
    profile: {
      name: 'web',
      dshHome: '/tmp/x',
      receipt: { algo: 'sha256', files: {}, tree: '0'.repeat(64) },
      manifest: { name: null, bundles: [], patchReload: null },
      dependencies: [],
    },
    files: [],
    homePatch: null,
    derived: { rootConfigPresent: true, rootConfigClean: true },
    secretsBundle: null,
    unmanaged: [],
  }
}

async function seedManifest(home: string, manifest: SnapshotManifest): Promise<void> {
  const dir = join(home, 'world-line', 'vault', 'snapshots')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${manifest.id}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
}

function makeCtx(home: string): CliContext {
  return {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: home, WORLD_LINE_DISABLE_KEYCHAIN: '1' },
    home,
    profileName: 'web',
    json: false,
    breakStaleLock: false,
    now: () => new Date('2026-09-04T12:00:00.000Z'),
  }
}

/** 25 same-day snapshots; only the newest 20 survive unless pinned. */
async function seedFlat25(home: string): Promise<string[]> {
  const ids: string[] = []
  for (let index = 1; index <= 25; index += 1) {
    const id = `snap-flat-${String(index).padStart(2, '0')}`
    const stamp = `2026-09-04T0${String(Math.floor(index / 10))}:${String((index % 10) * 6).padStart(2, '0')}:00.000Z`
    ids.push(id)
    await seedManifest(home, manifestOf(id, stamp, null))
  }
  return ids
}

describe('timeline prune', () => {
  test('dry run lists the plan and removes nothing', async () => {
    const home = await makeTempHome()
    try {
      const ids = await seedFlat25(home)
      const result = await runTimelinePrune(makeCtx(home), {})
      expect(result.dryRun).toBe(true)
      expect(result.delete).toHaveLength(5)
      expect(result.delete).not.toContain(ids[24])
      expect(result.delete).toContain(ids[0])
      expect(result.removed).toEqual([])
      const { readdir } = await import('node:fs/promises')
      expect(await readdir(join(home, 'world-line', 'vault', 'snapshots'))).toHaveLength(25)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('--yes deletes the planned manifests', async () => {
    const home = await makeTempHome()
    try {
      const ids = await seedFlat25(home)
      const result = await runTimelinePrune(makeCtx(home), { yes: true })
      expect(result.dryRun).toBe(false)
      expect(result.removed).toHaveLength(5)
      expect(result.removed).toContain(ids[0])
      const { readdir } = await import('node:fs/promises')
      const remaining = await readdir(join(home, 'world-line', 'vault', 'snapshots'))
      expect(remaining).toHaveLength(20)
      expect(remaining).toContain(`${ids[24]}.json`)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('lastKnownGood pins survive and protect their parents', async () => {
    const home = await makeTempHome()
    try {
      const ids: string[] = []
      for (let index = 1; index <= 8; index += 1) {
        const id = `snap-chain-${index}`
        ids.push(id)
        const previous = index === 1 ? null : `snap-chain-${index - 1}`
        const stamp = `2026-09-04T00:0${index}:00:00.000Z`
        await seedManifest(home, manifestOf(id, stamp, previous))
      }
      const stateDir = join(home, 'world-line', 'vault')
      await mkdir(stateDir, { recursive: true })
      await writeFile(
        join(stateDir, 'state.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            createdAt: '2026-09-04T00:00:00.000Z',
            updatedAt: '2026-09-04T00:00:00.000Z',
            lastSnapshots: { web: ids[7] },
            lastKnownGood: { web: ids[1] },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const result = await runTimelinePrune(makeCtx(home), { yes: true })
      // Pinned snap-chain-2 (LKG) plus its parent chain (1) survive;
      // the rest of the same day is pruned down to the daily newest.
      expect(result.protected).toContain(ids[1])
      expect(result.removed).not.toContain(ids[0])
      expect(result.removed).not.toContain(ids[1])
      const { readdir } = await import('node:fs/promises')
      const remaining = await readdir(join(home, 'world-line', 'vault', 'snapshots'))
      expect(remaining).toContain('snap-chain-1.json')
      expect(remaining).toContain('snap-chain-2.json')
      expect(remaining).toContain('snap-chain-8.json')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a full parent chain is never pruned', async () => {
    const home = await makeTempHome()
    try {
      const ids: string[] = []
      for (let index = 1; index <= 25; index += 1) {
        const id = `snap-fam-${String(index).padStart(2, '0')}`
        ids.push(id)
        const previous = index === 1 ? null : `snap-fam-${String(index - 1).padStart(2, '0')}`
        const stamp = `2026-09-04T00:00:0${String(index).padStart(2, '0')}.000Z`
        await seedManifest(home, manifestOf(id, stamp, previous))
      }
      const result = await runTimelinePrune(makeCtx(home), { yes: true })
      expect(result.delete).toEqual([])
      expect(result.removed).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })

  test('only the current profile is pruned; foreign snapshots stay', async () => {
    const home = await makeTempHome()
    try {
      await seedFlat25(home)
      const foreign = manifestOf('snap-other-1', '2026-08-01T00:00:00.000Z', null)
      await seedManifest(home, { ...foreign, profile: { ...foreign.profile, name: 'other' } })
      const result = await runTimelinePrune(makeCtx(home), { yes: true })
      expect(result.removed).toHaveLength(5)
      const { readdir } = await import('node:fs/promises')
      const remaining = await readdir(join(home, 'world-line', 'vault', 'snapshots'))
      expect(remaining).toContain('snap-other-1.json')
      expect(remaining).toHaveLength(21)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('CLI: prune without --yes exits 0 and prints the plan', async () => {
    const home = await makeTempHome()
    try {
      await seedFlat25(home)
      const plan = await runCliIn({ argv: ['timeline', 'prune'], home })
      expect(plan.exitCode).toBe(0)
      expect(plan.stdout).toContain('would delete')
      const dry = await runCliIn({ argv: ['timeline', 'prune', '--yes'], home })
      expect(dry.exitCode).toBe(0)
      expect(dry.stdout).toContain('removed')
      const after = await runCliIn({ argv: ['timeline', 'prune'], home })
      expect(after.stdout).toContain('nothing to prune')
    } finally {
      await destroyTempHome(home)
    }
  })
})
