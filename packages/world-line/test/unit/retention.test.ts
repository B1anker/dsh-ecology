/**
 * Time Machine retention planner tests (pure policy over manifest lists):
 * recent/daily/weekly bucketing, parent-chain protection, lastKnownGood
 * protection, and cross-profile isolation.
 */

import { describe, expect, test } from '@rstest/core'

import type { SnapshotManifest } from '../../src/domain/snapshot.js'
import { isoWeekKey, planRetention, type RetentionPolicy } from '../../src/vault/retention.js'

let seq = 0
const EMPTY_RECEIPT = {
  algo: 'sha256' as const,
  files: {},
  tree: '0'.repeat(64),
}

function snapshot(createdAt: string, parentId: string | null = null): SnapshotManifest {
  seq += 1
  return {
    formatVersion: 1,
    kind: 'profile-snapshot',
    id: `snap-test-${seq}`,
    createdAt,
    label: null,
    parentId,
    action: 'snapshot',
    candidateSource: null,
    validation: null,
    retention: null,
    createdBy: { worldLineVersion: '0.1.0', environment: { node: 'x', os: 'x', arch: 'x' } },
    dsh: { cliVersion: '0.1.2-rc.1', known: true, adapterId: 'dsh-0.1.x' },
    profile: {
      name: 'web',
      dshHome: '/tmp/x',
      receipt: EMPTY_RECEIPT,
      manifest: {
        name: null,
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: null,
      },
      dependencies: [],
    },
    files: [],
    homePatch: null,
    derived: { rootConfigPresent: true, rootConfigClean: true },
    secretsBundle: null,
    unmanaged: [],
  }
}

const tiny: RetentionPolicy = { recent: 2, daily: 3, weekly: 3 }

describe('iso week key', () => {
  test('anchors known dates to their ISO weeks', () => {
    expect(isoWeekKey('2026-09-04T12:00:00.000Z')).toBe('2026-W36')
    expect(isoWeekKey('2026-01-01T00:00:00.000Z')).toBe('2026-W01')
    expect(isoWeekKey('2026-12-31T00:00:00.000Z')).toBe('2026-W53')
  })
})

describe('planRetention', () => {
  test('keeps the recent bucket and the newest snapshot of kept days', () => {
    const snapshots = [
      snapshot('2026-09-01T08:00:00.000Z'),
      snapshot('2026-09-01T20:00:00.000Z'),
      snapshot('2026-09-02T08:00:00.000Z'),
      snapshot('2026-09-02T20:00:00.000Z'),
      snapshot('2026-09-03T08:00:00.000Z'),
    ]
    const plan = planRetention({ snapshots, profileName: 'web', policy: tiny })
    // recent=2 keeps the two newest; daily keeps newest of each of 3 days.
    const [s1, s2, s3, s4, s5] = snapshots
    expect(plan.keepIds).toContain(s5!.id)
    expect(plan.keepIds).toContain(s4!.id)
    expect(plan.keepIds).toContain(s2!.id) // newest of 2026-09-01
    expect(plan.deleteIds).toEqual([s1!.id, s3!.id])
    expect(plan.deleteIds).not.toContain(s4!.id)
  })

  test('protects the parent chain of every kept snapshot', () => {
    const oldest = snapshot('2026-08-01T00:00:00.000Z')
    const middle = snapshot('2026-08-10T00:00:00.000Z', oldest.id)
    const newest = snapshot('2026-09-03T00:00:00.000Z', middle.id)
    const plan = planRetention({
      snapshots: [oldest, middle, newest],
      profileName: 'web',
      policy: { recent: 2, daily: 2, weekly: 2 },
    })
    expect(plan.deleteIds).toEqual([])
    expect(plan.protectedReasons.get(oldest.id)).toMatch(/parent of/)
  })

  test('lastKnownGood is protected even when older than every bucket', () => {
    const lkg = snapshot('2026-01-01T00:00:00.000Z')
    const a = snapshot('2026-06-01T00:00:00.000Z', lkg.id)
    const b = snapshot('2026-07-01T00:00:00.000Z', a.id)
    const c = snapshot('2026-08-01T00:00:00.000Z', b.id)
    const plan = planRetention({
      snapshots: [lkg, a, b, c],
      profileName: 'web',
      policy: { recent: 2, daily: 2, weekly: 2 },
      protectedIds: [lkg.id],
    })
    expect(plan.keepIds).toContain(lkg.id)
    expect(plan.keepIds).toContain(a.id) // parent chain of lkg is protected too
    expect(plan.deleteIds).toEqual([])
    expect(plan.protectedReasons.get(lkg.id)).toMatch(/lastKnownGood/)
  })

  test('only the requested profile is planned (isolation)', () => {
    const webOld = snapshot('2026-01-01T00:00:00.000Z')
    const other = {
      ...snapshot('2026-01-01T00:00:00.000Z'),
      id: 'snap-other-1',
      profile: {
        name: 'dev',
        dshHome: '/tmp/y',
        receipt: EMPTY_RECEIPT,
        manifest: {
          name: null,
          bundles: [],
          patchReload: null,
        },
        dependencies: [],
      },
    }
    const webNew = snapshot('2026-09-01T00:00:00.000Z')
    const plan = planRetention({
      snapshots: [webOld, other, webNew],
      profileName: 'web',
      policy: { recent: 1, daily: 1, weekly: 1 },
    })
    expect(plan.deleteIds).toEqual([webOld.id])
    expect(plan.deleteIds).not.toContain('snap-other-1')
  })

  test('a protected id from another profile is kept but not a deletion barrier for it', () => {
    const a = snapshot('2026-01-01T00:00:00.000Z')
    const b = snapshot('2026-09-01T00:00:00.000Z')
    const plan = planRetention({
      snapshots: [a, b],
      profileName: 'web',
      policy: { recent: 1, daily: 1, weekly: 1 },
      protectedIds: [a.id],
    })
    expect(plan.deleteIds).toEqual([])
  })

  test('daily and weekly buckets dedupe against already-kept ids', () => {
    const sameDay = [
      snapshot('2026-09-01T00:00:00.000Z'),
      snapshot('2026-09-01T12:00:00.000Z'),
      snapshot('2026-09-01T23:59:00.000Z'),
      snapshot('2026-09-02T00:00:00.000Z'),
    ]
    const plan = planRetention({ snapshots: sameDay, profileName: 'web', policy: tiny })
    // recent=2 keeps the two newest; daily keeps newest of Sep 1 (already kept).
    const [d1, d2] = sameDay
    expect(new Set(plan.deleteIds).size).toBe(plan.deleteIds.length)
    expect(plan.deleteIds).toEqual([d1!.id, d2!.id])
  })
})
