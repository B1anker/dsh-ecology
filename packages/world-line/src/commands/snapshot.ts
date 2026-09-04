/**
 * `dsh-world-line snapshot create` (WORLD-LINE-SPEC §3, Phase 1).
 *
 * Takes the per-profile writer lock, analyses the official profile in one
 * read pass, persists whitelisted files as content objects, writes one
 * immutable snapshot manifest plus the pre-promote-style record of what was
 * captured, and updates store state. Never touches anything outside the
 * world-line store and never modifies the profile.
 */

import type { CliContext } from '../context.js'
import { runtimeEnvironment } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { ensureProfileDir } from '../domain/profile.js'
import { redactText } from '../domain/redaction.js'
import type { SnapshotManifest } from '../domain/snapshot.js'
import { analyzeProfile, buildManifest, newSnapshotId } from '../domain/snapshot.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { findDshBinary, readDshVersion } from '../host-adapters/detect.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { latestSnapshotFor, writeSnapshotManifest } from '../vault/manifests.js'
import { putObject } from '../vault/objects.js'
import { noteSnapshot } from '../vault/state.js'

/** Options for one snapshot create run. */
export interface SnapshotCreateOptions {
  label: string | null
}

/** The result of one snapshot create run. */
export interface SnapshotCreateResult {
  id: string
  createdAt: string
  profileName: string
  home: string
  label: string | null
  parentId: string | null
  dsh: { cliVersion: string | null; known: boolean; adapterId: string | null }
  files: { name: string; role: string; stored: boolean; secretSkipped: boolean; sha256: string }[]
  storedObjects: number
  skippedSecrets: string[]
  warnings: string[]
}

const LABEL_MAX = 200

/** Validate a snapshot label. */
export function validateLabel(label: string): void {
  if (label.length > LABEL_MAX) {
    throw new UsageError(`label is too long (${label.length} > ${LABEL_MAX} characters)`)
  }
  for (let index = 0; index < label.length; index += 1) {
    const code = label.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      throw new UsageError('label must not contain control characters')
    }
  }
}

/** Run `snapshot create`; writes only inside the world-line store. */
export async function runSnapshotCreate(
  ctx: CliContext,
  options: SnapshotCreateOptions,
): Promise<SnapshotCreateResult> {
  const { home, profileName } = ctx
  const now = ctx.now()
  const createdAt = now.toISOString()
  const id = newSnapshotId(now)

  // Version detection is advisory for snapshots (invariant 7 read-only
  // carve-out), so a missing/unknown binary records facts instead of failing.
  const binary = findDshBinary(ctx.env)
  const version = binary === null ? null : readDshVersion(binary)
  const verdict = adapterDsh01x.verdict(version, version === null)
  const dshFacts = {
    cliVersion: version?.raw ?? null,
    known: verdict.known,
    adapterId: verdict.known ? adapterDsh01x.id : null,
  }

  // Refuse before any writer-side work: no lock and no store dirs are ever
  // created for a profile (or home) that does not exist.
  await ensureProfileDir(profileDir(home, profileName))

  const lock = await acquireLock({
    lockPath: profileLockPath(home, profileName),
    purpose: `snapshot create ${id}`,
    breakStale: ctx.breakStaleLock,
    now,
  })
  try {
    const storedObjects = new Set<string>()
    const analysis = await analyzeProfile({
      home,
      profileName,
      adapter: adapterDsh01x,
      store: async (_name: string, bytes: Buffer) => {
        const outcome = await putObject(home, bytes)
        storedObjects.add(outcome.sha256)
      },
    })

    const parentId = await latestSnapshotFor(home, profileName)
    const manifest: SnapshotManifest = buildManifest({
      analysis,
      home,
      id,
      createdAt,
      label: options.label,
      parentId,
      dsh: dshFacts,
      ...runtimeEnvironment(),
    })

    await writeSnapshotManifest(home, manifest)
    await noteSnapshot(home, profileName, id)

    const skippedSecrets = analysis.files
      .filter((record) => record.secretSkipped)
      .map((record) => record.name)
    if (analysis.homePatch?.secretSkipped === true)
      skippedSecrets.push('$DSH_HOME/cordis.patch.yml')

    const warnings: string[] = []
    if (!verdict.known) {
      warnings.push(
        redactText(
          `dsh version ${version?.raw ?? '(undetectable)'} is outside the tested set ` +
            `(${adapterDsh01x.testedVersions.join(', ')}); the snapshot recorded facts only`,
        ),
      )
    }
    if (skippedSecrets.length > 0) {
      warnings.push(
        `secret-shaped content in ${skippedSecrets.join(', ')} was not stored (Phase 4 crypto vault pending)`,
      )
    }
    if (analysis.lockfileParseError !== null) {
      warnings.push('lockfile could not be parsed; resolved-version tracking is degraded')
    }

    return {
      id,
      createdAt,
      profileName,
      home,
      label: options.label,
      parentId,
      dsh: dshFacts,
      files: analysis.files.map((record) => ({
        name: record.name,
        role: record.role,
        stored: record.object !== null,
        secretSkipped: record.secretSkipped,
        sha256: record.sha256,
      })),
      storedObjects: storedObjects.size,
      skippedSecrets,
      warnings,
    }
  } finally {
    await lock.release()
  }
}
