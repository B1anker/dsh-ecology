/**
 * Snapshot manifest persistence (`world-line/vault/snapshots/<id>.json`).
 *
 * Manifests are immutable (WORLD-LINE-SPEC §7): written once with an atomic
 * rename, never rewritten, and refused on id collision. Reads validate the
 * envelope (format version, kind, id ↔ file name); anything else is an
 * invariant error — a corrupt store — not a normal file error.
 */

import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FileError, InvariantError, UsageError } from '../domain/errors.js'
import type { SnapshotManifest } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { snapshotManifestPath, snapshotsDir } from '../fs/paths.js'
import { WORLD_LINE_FORMAT_VERSION } from '../identity.js'

/** Validate a snapshot id supplied on the command line. */
export function assertSnapshotId(id: string): void {
  if (!/^snap-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)) {
    throw new UsageError(`invalid snapshot id ${JSON.stringify(id)}`)
  }
}

/** Persist one immutable snapshot manifest; refuses id collisions. */
export async function writeSnapshotManifest(
  home: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const path = snapshotManifestPath(home, manifest.id)
  let handle
  try {
    handle = await open(path, 'r')
    throw new InvariantError(`snapshot id collision: ${manifest.id} already exists in the vault`)
  } catch (error) {
    if (error instanceof InvariantError) throw error
    // ENOENT is the expected "free id" answer.
  } finally {
    await handle?.close().catch(() => {})
  }
  const raw = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFileAtomic(path, raw, { mode: 0o600 })
}

/** Read and validate one snapshot manifest by id. */
export async function readSnapshotManifest(home: string, id: string): Promise<SnapshotManifest> {
  assertSnapshotId(id)
  const path = snapshotManifestPath(home, id)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileError(`no snapshot ${id} in the vault at ${path}`)
    }
    throw new FileError(`failed to read snapshot ${id}: ${String(error)}`)
  }
  return parseSnapshotManifestText(raw, path, id)
}

/** Parse manifest text and validate its envelope invariants. */
export function parseSnapshotManifestText(
  raw: string,
  source: string,
  expectedId?: string,
): SnapshotManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new InvariantError(`snapshot manifest ${source} is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvariantError(`snapshot manifest ${source} must hold a JSON object`)
  }
  const manifest = parsed as Partial<SnapshotManifest>
  if (manifest.formatVersion === undefined || manifest.formatVersion > WORLD_LINE_FORMAT_VERSION) {
    throw new InvariantError(
      `snapshot manifest ${source} has unsupported format version ` +
        `${String(manifest.formatVersion)} (this world-line reads up to ${WORLD_LINE_FORMAT_VERSION})`,
    )
  }
  if (manifest.kind !== 'profile-snapshot' || typeof manifest.id !== 'string') {
    throw new InvariantError(`snapshot manifest ${source} is not a profile-snapshot manifest`)
  }
  if (expectedId !== undefined && manifest.id !== expectedId) {
    throw new InvariantError(
      `snapshot manifest ${source} declares id ${manifest.id}, expected ${expectedId}`,
    )
  }
  if (manifest.profile === undefined || typeof manifest.profile.name !== 'string') {
    throw new InvariantError(`snapshot manifest ${source} lacks its profile identity`)
  }
  return manifest as SnapshotManifest
}

/** One entry of a vault scan. */
export interface SnapshotListingEntry {
  id: string
  createdAt: string
  profileName: string
  label: string | null
}

/**
 * Scan the vault for every snapshot manifest. Corrupt entries are reported
 * separately so a single bad file cannot hide the rest of the timeline.
 */
export async function listSnapshotManifests(home: string): Promise<{
  snapshots: SnapshotManifest[]
  corrupt: string[]
}> {
  const directory = snapshotsDir(home)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { snapshots: [], corrupt: [] }
    }
    throw new FileError(`failed to read snapshot vault ${directory}`)
  }
  const snapshots: SnapshotManifest[] = []
  const corrupt: string[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(directory, name)
    try {
      const raw = await readFile(path, 'utf8')
      const manifest = parseSnapshotManifestText(raw, path, name.slice(0, -'.json'.length))
      snapshots.push(manifest)
    } catch (error) {
      corrupt.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  snapshots.sort((a, b) => {
    if (a.createdAt === b.createdAt) return a.id.localeCompare(b.id)
    return a.createdAt < b.createdAt ? -1 : 1
  })
  return { snapshots, corrupt }
}

/** Latest snapshot id for one profile, newest first, or null. */
export async function latestSnapshotFor(home: string, profileName: string): Promise<string | null> {
  const { snapshots } = await listSnapshotManifests(home)
  for (const manifest of [...snapshots].reverse()) {
    if (manifest.profile.name === profileName) return manifest.id
  }
  return null
}
