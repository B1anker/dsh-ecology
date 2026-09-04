/**
 * Semantic timeline diff (WORLD-LINE-SPEC §7: versions, patch entries,
 * configuration, local-plugin receipts). Pure and side-effect free — both
 * inputs are parsed snapshot manifests, and every value they carry was
 * already redacted at capture time, so a secret-value-only change compares
 * equal instead of leaking.
 */

import type { PatchEntrySummary } from './composition.js'
import type { SnapshotManifest } from './snapshot.js'

/** One changed/unchanged file pair. */
export interface FileDiffEntry {
  name: string
  role: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  before?: { sha256: string; stored: boolean; secretSkipped: boolean }
  after?: { sha256: string; stored: boolean; secretSkipped: boolean }
}

/** One dependency's semantic change. */
export interface DependencyDiffEntry {
  name: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  /** The fields whose values differ, when changed. */
  changedFields: string[]
}

/** One patch entry's semantic change, by layer file. */
export interface PatchDiffEntry {
  file: string
  key: string
  status: 'added' | 'removed' | 'changed'
  id?: string
}

/** The full diff between two snapshots. */
export interface ManifestDiff {
  aId: string
  bId: string
  meta: {
    labelChanged: boolean
    dshChanged: boolean
    environmentChanged: boolean
  }
  files: FileDiffEntry[]
  bundles: { changed: boolean; before: string[]; after: string[] }
  dependencies: DependencyDiffEntry[]
  patches: PatchDiffEntry[]
  derived: { changed: boolean }
  unmanaged: { added: string[]; removed: string[] }
}

/** Diff two snapshot manifests semantically. */
export function diffManifests(a: SnapshotManifest, b: SnapshotManifest): ManifestDiff {
  const files: FileDiffEntry[] = []
  const byName = new Map<
    string,
    { a?: SnapshotManifest['files'][number]; b?: SnapshotManifest['files'][number] }
  >()
  for (const record of a.files) {
    const slot = byName.get(record.name) ?? {}
    slot.a = record
    byName.set(record.name, slot)
  }
  for (const record of b.files) {
    const slot = byName.get(record.name) ?? {}
    slot.b = record
    byName.set(record.name, slot)
  }
  for (const name of [...byName.keys()].sort()) {
    const slot = byName.get(name)
    if (slot === undefined) continue
    const { a: before, b: after } = slot
    if (before === undefined && after !== undefined) {
      files.push({ name, role: after.role, status: 'added', after: fileFacts(after) })
    } else if (before !== undefined && after === undefined) {
      files.push({ name, role: before.role, status: 'removed', before: fileFacts(before) })
    } else if (before !== undefined && after !== undefined) {
      const changed =
        before.sha256 !== after.sha256 ||
        before.secretSkipped !== after.secretSkipped ||
        (before.object === null) !== (after.object === null)
      files.push({
        name,
        role: after.role,
        status: changed ? 'changed' : 'unchanged',
        before: changed ? fileFacts(before) : undefined,
        after: changed ? fileFacts(after) : undefined,
      })
    }
  }

  const bundles = {
    before: [...a.profile.manifest.bundles],
    after: [...b.profile.manifest.bundles],
  }
  const bundlesChanged = !sameStrings(bundles.before, bundles.after)

  const depNames = new Set([
    ...a.profile.dependencies.map((dependency) => dependency.name),
    ...b.profile.dependencies.map((dependency) => dependency.name),
  ])
  const dependencies: DependencyDiffEntry[] = []
  for (const name of [...depNames].sort()) {
    const before = a.profile.dependencies.find((dependency) => dependency.name === name)
    const after = b.profile.dependencies.find((dependency) => dependency.name === name)
    if (before === undefined && after !== undefined) {
      dependencies.push({ name, status: 'added', changedFields: [] })
      continue
    }
    if (before !== undefined && after === undefined) {
      dependencies.push({ name, status: 'removed', changedFields: [] })
      continue
    }
    if (before === undefined || after === undefined) continue
    const fields = dependencyChangedFields(before, after)
    dependencies.push({
      name,
      status: fields.length === 0 ? 'unchanged' : 'changed',
      changedFields: fields,
    })
  }

  const patches: PatchDiffEntry[] = []
  collectPatchDiffs('profile', a, b, patches)
  collectPatchDiffs('home', a, b, patches)

  const unmanagedA = new Set(a.unmanaged)
  const unmanagedB = new Set(b.unmanaged)
  const unmanaged = {
    added: [...unmanagedB].filter((name) => !unmanagedA.has(name)).sort(),
    removed: [...unmanagedA].filter((name) => !unmanagedB.has(name)).sort(),
  }

  return {
    aId: a.id,
    bId: b.id,
    meta: {
      labelChanged: (a.label ?? null) !== (b.label ?? null),
      dshChanged: a.dsh.cliVersion !== b.dsh.cliVersion || a.dsh.known !== b.dsh.known,
      environmentChanged:
        a.createdBy.environment.node !== b.createdBy.environment.node ||
        a.createdBy.environment.os !== b.createdBy.environment.os,
    },
    files: files.filter((entry) => entry.status !== 'unchanged'),
    bundles: { changed: bundlesChanged, ...bundles },
    dependencies,
    patches,
    derived: {
      changed:
        a.derived.rootConfigPresent !== b.derived.rootConfigPresent ||
        a.derived.rootConfigClean !== b.derived.rootConfigClean,
    },
    unmanaged,
  }
}

/** Compare a dependency record's semantically meaningful fields. */
function dependencyChangedFields(
  before: SnapshotManifest['profile']['dependencies'][number],
  after: SnapshotManifest['profile']['dependencies'][number],
): string[] {
  const fields: string[] = []
  if (before.spec !== after.spec) fields.push('spec')
  if (before.kind !== after.kind) fields.push('kind')
  if ((before.target ?? null) !== (after.target ?? null)) fields.push('target')
  if ((before.gitHead ?? null) !== (after.gitHead ?? null)) fields.push('gitHead')
  if ((before.contentHash ?? null) !== (after.contentHash ?? null)) fields.push('contentHash')
  if ((before.targetExists ?? null) !== (after.targetExists ?? null)) fields.push('targetExists')
  const resolvedBefore = before.resolved ?? {}
  const resolvedAfter = after.resolved ?? {}
  if ((resolvedBefore.version ?? null) !== (resolvedAfter.version ?? null))
    fields.push('resolved.version')
  if ((resolvedBefore.integrity ?? null) !== (resolvedAfter.integrity ?? null))
    fields.push('resolved.integrity')
  if ((resolvedBefore.url ?? null) !== (resolvedAfter.url ?? null)) fields.push('resolved.url')
  return fields
}

/** Compare two entry lists by position + redacted payload. */

/** Emit patch-entry diffs for one layer file into the accumulator. */
function collectPatchDiffs(
  file: 'profile' | 'home',
  a: SnapshotManifest,
  b: SnapshotManifest,
  out: PatchDiffEntry[],
): void {
  const layerA = layerEntries(file, a)
  const layerB = layerEntries(file, b)
  const width = Math.max(layerA.length, layerB.length)
  for (let index = 0; index < width; index += 1) {
    const before = layerA[index]
    const after = layerB[index]
    if (before === undefined && after === undefined) continue
    if (before === undefined && after !== undefined) {
      out.push({ file, key: `#${index + 1}`, status: 'added', id: after.id })
    } else if (before !== undefined && after === undefined) {
      out.push({ file, key: `#${index + 1}`, status: 'removed', id: before.id })
    } else if (before !== undefined && after !== undefined) {
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        out.push({
          file,
          key: `#${index + 1} (id: ${before.id ?? '(none)'})`,
          status: 'changed',
          id: after.id,
        })
      }
    }
  }
}

/** The entries summary of one layer from a manifest. */
function layerEntries(file: 'profile' | 'home', manifest: SnapshotManifest): PatchEntrySummary[] {
  if (file === 'profile') {
    const record = manifest.files.find((entry) => entry.role === 'profile-patch')
    if (record?.parseError !== undefined) return []
    return record?.entries ?? []
  }
  if (manifest.homePatch === null || !manifest.homePatch.present) return []
  if (manifest.homePatch.parseError !== undefined) return []
  return manifest.homePatch.entries ?? []
}

function fileFacts(record: SnapshotManifest['files'][number]): {
  sha256: string
  stored: boolean
  secretSkipped: boolean
} {
  return {
    sha256: record.sha256,
    stored: record.object !== null,
    secretSkipped: record.secretSkipped,
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
