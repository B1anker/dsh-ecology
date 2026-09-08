import { withOperations } from '../fs/operation.js'
import { labHomeDir } from './layout.js'
import { readLabManifest } from './manifest.js'
/**
 * Lab cleanup (WORLD-LINE-SPEC §3/§6, Phase 2): explicit `lab destroy` and the
 * automatic reap of failed labs whose 7-day diagnostic window expired.
 * Successful runs already clean up by default inside `runLabTransaction` —
 * this module handles the retained-lab bookkeeping:
 *
 *   - destroy: refuses mid-run labs (a booted host would be orphaned);
 *     removes the whole lab dir. A dir without a manifest (or with a corrupt
 *     one) is still removed — an explicit destroy names a directory.
 *   - reapExpired: destroys every `failed` lab with an `expiresAt` in the
 *     past, plus leftover `destroyed`-lab dirs whose manifest already moved
 *     on. Read-only commands trigger it so retention cannot silently grow.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileError, InvariantError, UsageError } from '../domain/errors.js'
import { acquireLock } from '../fs/lock.js'
import { removeLabDefault } from './defaults.js'
import { labExists, labManifestPath, labRoot, listLabs } from './layout.js'
import type { LabManifest } from './manifest.js'
import { isApplying, parseLabManifestText } from './manifest.js'
import { rmLab } from './run.js'
import { readService } from './service.js'

export interface DestroyResult {
  id: string
  removed: boolean
}

/** Destroy one lab by id (explicit user action; state machine permitting). */
async function destroyLabUnlocked(home: string, labId: string): Promise<DestroyResult> {
  const service = await readService(home, labId)
  if (service?.state === 'running')
    throw new UsageError(`lab ${labId} is running; use lab stop first`)
  if (!(await labExists(home, labId))) {
    throw new UsageError(`no such lab ${labId} under this home`)
  }
  let manifest: LabManifest | null = null
  try {
    const text = await readFile(labManifestPath(home, labId), 'utf8')
    manifest = parseLabManifestText(text, labId)
  } catch (error) {
    if (!(error instanceof FileError)) throw error
    manifest = null // missing/corrupt manifest: explicit destroy still removes the dir
  }
  if (manifest !== null && manifest.state === 'destroyed') {
    throw new InvariantError(`lab ${labId} is already destroyed`)
  }
  if (manifest !== null && isApplying(manifest)) {
    throw new InvariantError(
      `lab ${labId} is mid-run (${manifest.state}) — refusing to destroy an active lab`,
    )
  }
  await rmLab(home, labId)
  await removeLabDefault(home, labId)
  return { id: labId, removed: true }
}

export interface ReapResult {
  reaped: string[]
  scanned: number
}

/**
 * Reap labs whose retention expired (failed labs kept 7 days) and lab dirs
 * left over after a crash. Returns what was removed; never throws on a
 * corrupt manifest (those are reported as skipped).
 */
export async function reapExpiredLabs(home: string, now: Date): Promise<ReapResult> {
  const ids = await listLabs(home)
  const reaped: string[] = []
  for (const labId of ids) {
    let text: string | null = null
    try {
      text = await readFile(labManifestPath(home, labId), 'utf8')
    } catch {
      text = null
    }
    let manifest: LabManifest | null = null
    if (text !== null) {
      try {
        manifest = parseLabManifestText(text, labId)
      } catch {
        manifest = null // corrupt manifests are left for explicit destroy
      }
    }
    if (manifest === null) continue
    if (
      manifest.state === 'failed' &&
      manifest.retention.expiresAt !== undefined &&
      manifest.retention.expiresAt <= now.toISOString() &&
      !isApplying(manifest)
    ) {
      await rmLab(home, labId)
      reaped.push(labId)
    }
  }
  return { reaped, scanned: ids.length }
}

export async function destroyLab(home: string, labId: string): Promise<DestroyResult> {
  const manifest = await readLabManifest(home, labId).catch(() => null)
  return withOperations([labHomeDir(home, labId)], manifest?.source.profileName ?? 'web', () =>
    destroyLabGuarded(home, labId),
  )
}
async function destroyLabGuarded(home: string, labId: string): Promise<DestroyResult> {
  const lock = await acquireLock({
    lockPath: join(labRoot(home), '.service.lock'),
    purpose: 'lab destroy',
  })
  try {
    return await destroyLabUnlocked(home, labId)
  } finally {
    await lock.release()
  }
}
