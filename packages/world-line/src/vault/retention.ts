/**
 * Time Machine retention (WORLD-LINE-SPEC §7, Phase 4): snapshots are kept
 * by policy — the most recent 20, the newest one of each day, and the newest
 * one of each ISO week — while protected snapshots (the `lastKnownGood`
 * reference of a profile and the parent chain of every kept snapshot) can
 * never be planned for deletion. The planner is a pure function over the
 * immutable manifest list; the CLI layer shows the plan first and only
 * deletes after explicit confirmation.
 *
 * Vault objects are content-addressed and deduplicated across manifests, so
 * deletion here removes snapshot manifests and their secret bundles only —
 * object collection is out of scope until a full reference count exists
 * (documented in docs/phase4-design.md).
 */

import type { SnapshotManifest } from '../domain/snapshot.js'

/** Retention policy knobs (defaults from WORLD-LINE-SPEC §7). */
export interface RetentionPolicy {
  /** Newest snapshots always kept, per profile. */
  recent: number
  /** Newest snapshot of each UTC day kept, per profile. */
  daily: number
  /** Newest snapshot of each UTC ISO week kept, per profile. */
  weekly: number
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  recent: 20,
  daily: 14,
  weekly: 12,
}

/** The prune answer: which snapshots survive and which are candidates. */
export interface RetentionPlan {
  /** Snapshot ids the policy keeps (including protected chains). */
  keepIds: Set<string>
  /** Snapshot ids the policy would delete (never includes protected ids). */
  deleteIds: string[]
  /** Reasons per protected id, for human output. */
  protectedReasons: Map<string, string>
}

function utcDayKey(iso: string): string {
  return iso.slice(0, 10)
}

/** ISO week key (year + week number, Monday-based), for weekly bucketing. */
export function isoWeekKey(iso: string): string {
  const date = new Date(iso)
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * Decide what survives for one profile's timeline. `protected` ids are never
 * deleted: their whole parent chain is walked and also protected.
 */
export function planRetention(options: {
  snapshots: SnapshotManifest[]
  profileName: string
  policy?: RetentionPolicy
  /** Explicitly protected ids (e.g. lastKnownGood); parents walk from here. */
  protectedIds?: readonly string[]
}): RetentionPlan {
  const policy = options.policy ?? DEFAULT_RETENTION_POLICY
  const byId = new Map(options.snapshots.map((snapshot) => [snapshot.id, snapshot]))
  const profileIds = options.snapshots
    .filter((snapshot) => snapshot.profile.name === options.profileName)
    .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1))
  const profile = new Set(profileIds.map((snapshot) => snapshot.id))
  const keepIds = new Set<string>()
  const protectedReasons = new Map<string, string>()

  const protect = (id: string, reason: string): void => {
    if (keepIds.has(id)) return
    keepIds.add(id)
    protectedReasons.set(id, reason)
    const snapshot = byId.get(id)
    if (
      snapshot?.parentId !== null &&
      snapshot?.parentId !== undefined &&
      byId.has(snapshot.parentId)
    ) {
      protect(snapshot.parentId, `parent of ${id}`)
    }
  }

  for (const id of options.protectedIds ?? []) {
    if (byId.has(id) && profile.has(id)) protect(id, 'explicitly protected (lastKnownGood)')
    else if (byId.has(id)) protect(id, 'explicitly protected')
  }

  // Newest first: recent bucket is the policy.recent newest ids.
  const newestFirst = [...profileIds].reverse()
  for (const snapshot of newestFirst.slice(0, policy.recent)) {
    protect(snapshot.id, `within the ${policy.recent} most recent`)
  }

  // Daily bucket: the newest snapshot of each UTC day, up to policy.daily days.
  const seenDays = new Set<string>()
  let dailyKept = 0
  for (const snapshot of newestFirst) {
    const day = utcDayKey(snapshot.createdAt)
    if (seenDays.has(day)) continue
    seenDays.add(day)
    if (dailyKept >= policy.daily) break
    dailyKept += 1
    protect(snapshot.id, `newest of day ${day}`)
  }

  // Weekly bucket: the newest snapshot of each ISO week, up to policy.weekly weeks.
  const seenWeeks = new Set<string>()
  let weeklyKept = 0
  for (const snapshot of newestFirst) {
    const week = isoWeekKey(snapshot.createdAt)
    if (seenWeeks.has(week)) continue
    seenWeeks.add(week)
    if (weeklyKept >= policy.weekly) break
    weeklyKept += 1
    protect(snapshot.id, `newest of week ${week}`)
  }

  const deleteIds: string[] = []
  for (const snapshot of profileIds) {
    if (!keepIds.has(snapshot.id)) deleteIds.push(snapshot.id)
  }
  return { keepIds, deleteIds, protectedReasons }
}
