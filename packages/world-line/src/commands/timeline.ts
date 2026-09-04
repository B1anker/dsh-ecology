/**
 * `dsh-world-line timeline` — list / show / diff of the profile time machine
 * (WORLD-LINE-SPEC §3, Phase 1). Read-only: opens the vault, never writes.
 */

import { rm } from 'node:fs/promises'
import type { CliContext } from '../context.js'
import type { ManifestDiff } from '../domain/diff.js'
import { diffManifests } from '../domain/diff.js'
import { FileError } from '../domain/errors.js'
import type { SnapshotManifest } from '../domain/snapshot.js'
import { acquireLock } from '../fs/lock.js'
import { profileLockPath, secretBundlePath, snapshotManifestPath } from '../fs/paths.js'
import {
  latestSnapshotFor,
  listSnapshotManifests,
  readSnapshotManifest,
} from '../vault/manifests.js'
import { planRetention } from '../vault/retention.js'
import { readState } from '../vault/state.js'

/** One timeline row for `list`. */
export interface TimelineRow {
  id: string
  createdAt: string
  profileName: string
  label: string | null
  parentId: string | null
  files: number
  stored: number
  secretSkipped: number
  dependencies: number
  bundles: number
  dshCliVersion: string | null
}

/** The `timeline list` answer. */
export interface TimelineListResult {
  profileName: string
  snapshots: TimelineRow[]
  corrupt: string[]
}

/** The `timeline show` answer (all manifest data). */
export interface TimelineShowResult {
  id: string
  manifest: SnapshotManifest
}

/** The `timeline diff` answer. */
export interface TimelineDiffResult {
  fromId: string
  toId: string
  diff: ManifestDiff
  changedFiles: number
  changedDependencies: number
  changedPatches: number
}

/** Run `timeline list`. */
export async function runTimelineList(ctx: CliContext): Promise<TimelineListResult> {
  const { home, profileName } = ctx
  const { snapshots, corrupt } = await listSnapshotManifests(home)
  const rows: TimelineRow[] = snapshots
    .filter((manifest) => manifest.profile.name === profileName)
    .reverse()
    .map((manifest) => rowOf(manifest))
  return { profileName, snapshots: rows, corrupt }
}

/** Run `timeline show <id>`. */
export async function runTimelineShow(ctx: CliContext, id: string): Promise<TimelineShowResult> {
  const manifest = await readSnapshotManifest(ctx.home, id)
  return { id, manifest }
}

/** Run `timeline diff <a> <b>`. */
export interface TimelinePruneResult {
  dryRun: boolean
  profileName: string
  total: number
  /** Snapshot ids the policy would delete / deleted. */
  delete: string[]
  /** Snapshot ids pinned by protection (lastKnownGood / parents). */
  protected: string[]
  removed: string[]
  corrupt: number
}

/**
 * Time-Machine retention prune (§7, Phase 4): newest 20 kept, newest 14 per
 * calendar day, newest 12 per ISO week — plan shown first (dry run), actual
 * deletion only with `--yes`. Pins: every recorded lastKnownGood /
 * lastSnapshots reference (any profile) plus each kept snapshot's parent
 * chain are never deleted. Removes only the snapshot manifest + its secret
 * bundle; content objects are shared and left for a future vault gc.
 */
export async function runTimelinePrune(
  ctx: CliContext,
  options: { yes?: boolean },
): Promise<TimelinePruneResult> {
  const now = ctx.now()
  const lock = await acquireLock({
    lockPath: profileLockPath(ctx.home, ctx.profileName),
    purpose: `timeline prune (${ctx.profileName})`,
    breakStale: ctx.breakStaleLock,
    now,
  })
  try {
    const { snapshots, corrupt } = await listSnapshotManifests(ctx.home)
    const state = await readState(ctx.home)
    const pinned = new Set<string>()
    for (const id of Object.values(state.lastKnownGood)) pinned.add(id)
    for (const id of Object.values(state.lastSnapshots)) pinned.add(id)
    const plan = planRetention({
      snapshots,
      profileName: ctx.profileName,
      protectedIds: [...pinned],
    })
    const removed: string[] = []
    if (options.yes === true) {
      for (const id of plan.deleteIds) {
        await rm(snapshotManifestPath(ctx.home, id), { force: true })
        await rm(secretBundlePath(ctx.home, id), { force: true })
        removed.push(id)
      }
    }
    return {
      dryRun: options.yes !== true,
      profileName: ctx.profileName,
      total: snapshots.length,
      delete: plan.deleteIds,
      protected: [...plan.protectedReasons.keys()],
      removed,
      corrupt: corrupt.length,
    }
  } finally {
    await lock.release()
  }
}

export async function runTimelineDiff(
  ctx: CliContext,
  aId: string,
  bId: string,
): Promise<TimelineDiffResult> {
  const [a, b] = await Promise.all([
    readSnapshotManifest(ctx.home, aId),
    readSnapshotManifest(ctx.home, bId),
  ])
  const diff = diffManifests(a, b)
  return {
    fromId: a.id,
    toId: b.id,
    diff,
    changedFiles: diff.files.length,
    changedDependencies: diff.dependencies.filter((entry) => entry.status !== 'unchanged').length,
    changedPatches: diff.patches.length,
  }
}

/** Latest snapshot id for the context's profile (used by `show` defaults). */
export async function latestSnapshotId(ctx: CliContext): Promise<string> {
  const id = await latestSnapshotFor(ctx.home, ctx.profileName)
  if (id === null) {
    throw new FileError(
      `no snapshot exists for profile ${JSON.stringify(ctx.profileName)} — ` +
        'run `dsh-world-line snapshot create` first',
    )
  }
  return id
}

/** Build one row from a manifest. */
function rowOf(manifest: SnapshotManifest): TimelineRow {
  const stored = manifest.files.filter((record) => record.object !== null).length
  const secretSkipped = manifest.files.filter((record) => record.secretSkipped).length
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    profileName: manifest.profile.name,
    label: manifest.label,
    parentId: manifest.parentId,
    files: manifest.files.length,
    stored,
    secretSkipped,
    dependencies: manifest.profile.dependencies.length,
    bundles: manifest.profile.manifest.bundles.length,
    dshCliVersion: manifest.dsh.cliVersion,
  }
}
