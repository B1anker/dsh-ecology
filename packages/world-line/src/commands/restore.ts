/**
 * Restore command (WORLD-LINE-SPEC §3/§7, Phase 4): lab-first restore of a
 * vault snapshot. The default flow only materializes a verification lab from
 * snapshot vault bytes (never touching the official profile); `--promote`
 * additionally rolls the verified snapshot state onto the official profile
 * through the lab-promote transaction (pre-promote snapshot → receipt
 * conflict re-check → atomic whitelist swap → after snapshot → journal).
 *
 * Failure discipline: an unmaterializable snapshot (missing objects or
 * undecryptable secret bundle) refuses before a lab exists; a failed restore
 * run leaves the official profile untouched and never deletes vault history.
 */

import type { CliContext } from '../context.js'
import { FileError, UsageError, VerificationError } from '../domain/errors.js'
import { ensureProfileDir } from '../domain/profile.js'
import type { SnapshotManifest } from '../domain/snapshot.js'
import { profileDir } from '../fs/paths.js'
import { createLab } from '../lab/create.js'
import { type KnownHost, requireKnownHost } from '../lab/gate.js'
import { labExists } from '../lab/layout.js'
import { runLabPromote } from '../lab/promote.js'
import type { LabRunDeps } from '../lab/run.js'
import { rmLab, runLabTransaction } from '../lab/run.js'
import { createKeyProvider } from '../vault/crypto.js'
import { assertSnapshotId, readSnapshotManifest } from '../vault/manifests.js'
import { readSecretBundleEntries } from '../vault/secrets.js'
import { lastKnownGoodFor } from '../vault/state.js'

export interface RestoreCommandResult {
  /** False when the restore lab failed verification (exit 1). */
  ok: boolean
  kind: 'verify' | 'promote'
  snapshotId: string
  labId: string
  clientGate?: 'pass' | 'fail' | 'inconclusive' | 'skipped'
  preSnapshot?: string
  afterSnapshot?: string
  promoted?: boolean
  restartVerified?: boolean
  deleted?: boolean
}

export interface RestoreCommandOptions {
  /** Positional snapshot id; mutually exclusive with lastKnownGood. */
  snapshotId?: string
  lastKnownGood?: boolean
  promote?: boolean
  acceptInconclusive?: boolean
  restart?: boolean
  /** Keep the restore lab after a successful promote. */
  keep?: boolean
  /** Test seam: inject capture/launch/browser fakes into the restore run. */
  deps?: Partial<LabRunDeps>
}

/** Resolve the restore target snapshot id (positional xor --last-known-good). */
export async function resolveRestoreSnapshot(
  ctx: CliContext,
  options: RestoreCommandOptions,
): Promise<string> {
  if (options.snapshotId !== undefined && options.lastKnownGood === true) {
    throw new UsageError('restore takes either a snapshot id or --last-known-good, not both')
  }
  if (options.snapshotId !== undefined) {
    assertSnapshotId(options.snapshotId)
    return options.snapshotId
  }
  if (options.lastKnownGood === true) {
    const lkg = await lastKnownGoodFor(ctx.home, ctx.profileName)
    if (lkg === null) {
      throw new FileError(
        `no last-known-good snapshot recorded for profile ${ctx.profileName} ` +
          `(promote with --restart records one)`,
      )
    }
    return lkg
  }
  throw new UsageError('restore needs a snapshot id (snap-…) or --last-known-good')
}

/** Read + decrypt a snapshot's secret material; null when none exists. */
async function secretMapFor(
  ctx: CliContext,
  snapshotId: string,
  manifest: SnapshotManifest,
  key: Buffer | null,
): Promise<Map<string, Buffer> | null> {
  const needsSecrets = manifest.files.some(
    (record) => record.secretStored === true || record.secretSkipped,
  )
  if (!needsSecrets) return null
  if (manifest.secretsBundle === null) {
    // Phase 1-3 vault: secret files were skipped entirely — not restorable.
    return null
  }
  if (key === null) {
    throw new VerificationError(
      `snapshot ${snapshotId} holds encrypted secrets but no key is available — ` +
        'restore needs the macOS Keychain or $WORLD_LINE_SECRET_KEY',
    )
  }
  return readSecretBundleEntries(ctx.home, snapshotId, key, manifest.secretsBundle.sha256)
}

/** Restore driver shared by the CLI verb paths. */
export async function runRestoreCommand(
  ctx: CliContext,
  options: RestoreCommandOptions,
): Promise<RestoreCommandResult> {
  const snapshotId = await resolveRestoreSnapshot(ctx, options)

  // Fail closed before any lab exists: the snapshot must exist and be
  // byte-materializable, and the official profile must be present and
  // lockable (a deleted official profile cannot host a restore).
  const manifest = await readSnapshotManifest(ctx.home, snapshotId)
  if (manifest.profile.name !== ctx.profileName) {
    throw new UsageError(
      `snapshot ${snapshotId} belongs to profile ${JSON.stringify(manifest.profile.name)}; ` +
        `restoring requires --profile ${manifest.profile.name}`,
    )
  }
  const host: KnownHost = requireKnownHost(ctx)
  const keyProvider = createKeyProvider({ env: ctx.env, home: ctx.home })
  const key = await keyProvider.getOrCreateKey()
  const secrets = await secretMapFor(ctx, snapshotId, manifest, key)

  const sourceDir = profileDir(ctx.home, ctx.profileName)
  await ensureProfileDir(sourceDir)

  const created = await createLab(ctx, host, ctx.profileName, {
    source: { snapshotId, manifest, secrets },
  })
  const labId = created.manifest.id

  const run = await runLabTransaction({
    ctx,
    host,
    labId,
    plan: [],
    keep: true,
    clientProbes: true,
    acceptClientInconclusive: options.acceptInconclusive,
    deps: options.deps,
  })
  const clientGate = run.clientReady ?? 'skipped'

  if (!run.ok) {
    return { ok: false, kind: 'verify', snapshotId, labId, clientGate }
  }
  if (options.promote !== true) {
    return { ok: true, kind: 'verify', snapshotId, labId, clientGate }
  }

  const promoted = await runLabPromote(ctx, {
    labId,
    acceptInconclusive: options.acceptInconclusive ?? false,
    restart: options.restart ?? false,
  })
  if (options.keep !== true) {
    if (await labExists(ctx.home, labId)) await rmLab(ctx.home, labId)
  }
  return {
    ok: true,
    kind: 'promote',
    snapshotId,
    labId,
    clientGate,
    preSnapshot: promoted.preSnapshot ?? undefined,
    afterSnapshot: promoted.afterSnapshot ?? undefined,
    promoted: true,
    restartVerified: promoted.restartVerified,
    deleted: options.keep !== true,
  }
}
