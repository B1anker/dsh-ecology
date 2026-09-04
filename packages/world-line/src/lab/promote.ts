/**
 * Promotion (WORLD-LINE-SPEC §7, Phase 3): the only sanctioned writer of the
 * official profile. Sequence per spec:
 *
 *   1. client gate (§6) — a failed client probe always refuses promotion;
 *      absent/inconclusive evidence blocks it unless `--accept-inconclusive`,
 *   2. receipt conflict check under the writer lock — the lab's sourceReceipt
 *      must equal the current official receipt,
 *   3. auto `pre-promote` snapshot (its own writer lock),
 *   4. re-check receipts and swap the lab's verified whitelist files into the
 *      official profile (same-filesystem staging + fsync + rename dance),
 *   5. journal `committed` + `after` snapshot,
 *   6. optional `--restart`: boot the official profile and require a full
 *      client probe — pass marks the after-snapshot lastKnownGood; any
 *      failure rolls the managed files back to the pre-promote snapshot
 *      contents (journal `rolled-back`). Default: no restart.
 *
 * Promote never copies lab runtime, logs, cookies, tokens or the lab home.
 */

import { readFile } from 'node:fs/promises'
import { runSnapshotCreate } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { UsageError, VerificationError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { redactText } from '../domain/redaction.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { adapterDsh01x, dshBootArgs } from '../host-adapters/dsh-0.1.x.js'
import { readSnapshotManifest } from '../vault/manifests.js'
import { readObject } from '../vault/objects.js'
import { noteLastKnownGood } from '../vault/state.js'
import { runClientProbe } from './browser.js'
import { WHITELIST_FILE_NAMES } from './create.js'
import type { KnownHost } from './gate.js'
import { requireKnownHost } from './gate.js'
import { appendJournal, newJournalId } from './journal.js'
import { launchDsh } from './launcher.js'
import { labExists, labProbePath, labProfileDir } from './layout.js'
import type { LabManifest } from './manifest.js'
import { readLabManifest } from './manifest.js'
import { runCaptured } from './runner.js'
import { existingManagedFiles, transactionalReplaceFiles } from './swap.js'

export type ClientGate = 'pass' | 'fail' | 'inconclusive'

/** Classify lab probe records for the promotion client gate (§6). */
export function classifyClientGate(probes: readonly ProbeResult[]): ClientGate {
  const relevant = probes.filter((entry) =>
    ['browser-boot', 'core-contract', 'candidate-contract'].includes(entry.check),
  )
  if (relevant.length === 0) return 'inconclusive'
  if (relevant.some((entry) => entry.status === 'fail')) return 'fail'
  const boot = relevant.find((entry) => entry.check === 'browser-boot')
  if (boot?.status === 'pass') return 'pass'
  return 'inconclusive'
}

export interface LabPromoteOptions {
  labId: string
  /** Accept inconclusive client evidence (never `fail`). */
  acceptInconclusive?: boolean
  /** Boot the official profile after the swap and require a full client probe. */
  restart?: boolean
  /** Injected launcher/client probe/installer for unit tests. */
  deps?: {
    launch?: typeof launchDsh
    clientProbe?: typeof runClientProbe
    install?: typeof runCaptured
  }
}

export interface LabPromoteResult {
  ok: boolean
  clientGate: ClientGate
  preSnapshot: string
  afterSnapshot: string | null
  appliedFiles: string[]
  restartVerified: boolean
  lastKnownGood: string | null
  journalId: string
}

async function readLabProbeProbes(home: string, labId: string): Promise<ProbeResult[]> {
  try {
    const raw = await readFile(labProbePath(home, labId), 'utf8')
    const parsed = JSON.parse(raw) as { probes?: ProbeResult[] }
    return parsed.probes ?? []
  } catch {
    return []
  }
}

/** Buffer source for one managed file of a lab (read-only copy). */
function labSourceOf(labProfileDirPath: string) {
  return async (name: string): Promise<Buffer> => readFile(`${labProfileDirPath}/${name}`)
}

/**
 * Roll the managed files of `officialDir` back to a snapshot. Names restored
 * come from the snapshot's stored whitelist objects; managed files the
 * snapshot never had (e.g. a lockfile the promote introduced) are deleted;
 * whitelist files whose content the snapshot skipped (secret policy) are left
 * alone. Returns the names the swap touched.
 */
async function rollbackManagedFiles(
  home: string,
  snapshotId: string,
  dir: string,
): Promise<string[]> {
  const manifest = await readSnapshotManifest(home, snapshotId)
  const whitelist = new Set<string>(WHITELIST_FILE_NAMES)
  const snapshotRecords = manifest.files.filter(
    (file) => whitelist.has(file.name) && file.object !== null && file.object !== undefined,
  )
  const snapshotNames = new Set(snapshotRecords.map((file) => file.name))
  const current = await existingManagedFiles(dir, WHITELIST_FILE_NAMES)
  const names = [...snapshotNames, ...current.filter((name) => !snapshotNames.has(name))]
  if (names.length === 0) return []
  const sourceOf = async (name: string): Promise<Buffer | string | null> => {
    const record = snapshotRecords.find((file) => file.name === name)
    if (record === undefined || record.object === null) return null
    return await readObject(home, record.object)
  }
  const swap = await transactionalReplaceFiles(dir, names, sourceOf)
  return swap.applied
}

function analyzeProfileNow(ctx: CliContext) {
  return analyzeProfile({
    home: ctx.home,
    profileName: ctx.profileName,
    adapter: adapterDsh01x,
  })
}

export async function runLabPromote(
  ctx: CliContext,
  options: LabPromoteOptions,
): Promise<LabPromoteResult> {
  const { labId } = options
  if (!(await labExists(ctx.home, labId))) {
    throw new UsageError(`no such lab ${labId} under this home`)
  }
  // Version gate: promotion writes the official profile — fail closed.
  const host: KnownHost = requireKnownHost(ctx)

  const manifest: LabManifest = await readLabManifest(ctx.home, labId)
  const labProfileName = manifest.source.profileName
  if (labProfileName !== ctx.profileName) {
    throw new UsageError(
      `lab ${labId} cloned profile ${JSON.stringify(labProfileName)}; ` +
        `promoting requires --profile ${labProfileName}`,
    )
  }
  if (manifest.state !== 'passed') {
    throw new UsageError(`lab ${labId} is ${manifest.state} — only a passed lab can be promoted`)
  }

  // Client gate (§6: hostReady alone is not enough; no reliable signal blocks
  // promotion unless accepted; a client failure is never overridable).
  const probes = await readLabProbeProbes(ctx.home, labId)
  const clientGate = classifyClientGate(probes)
  if (clientGate === 'fail') {
    throw new VerificationError(
      `lab ${labId} failed its client probes — promotion is refused ` +
        '(--accept-inconclusive never overrides a client failure)',
    )
  }
  if (clientGate === 'inconclusive' && options.acceptInconclusive !== true) {
    throw new VerificationError(
      `lab ${labId} has no reliable client-ready evidence — refusing to promote; ` +
        're-run the lab with browser probes or pass --accept-inconclusive',
    )
  }

  const officialDir = profileDir(ctx.home, ctx.profileName)
  const labProfileDirPath = labProfileDir(ctx.home, labId, labProfileName)
  const journalId = newJournalId(ctx.now())

  // Receipt conflict check #1 under the writer lock.
  const lock = await acquireLock({
    lockPath: profileLockPath(ctx.home, ctx.profileName),
    purpose: `promote lab ${labId}`,
    breakStale: ctx.breakStaleLock,
    now: ctx.now(),
  })
  try {
    const analysis = await analyzeProfileNow(ctx)
    if (analysis.receipt.tree !== manifest.source.receipt) {
      throw new UsageError(
        'official profile changed since the lab was created (receipt mismatch) — ' +
          'promotion refused; snapshot the current state and re-run the candidate',
      )
    }
  } finally {
    await lock.release()
  }

  // Auto pre-promote snapshot (its own writer lock inside runSnapshotCreate).
  const pre = await runSnapshotCreate(ctx, { label: `pre-promote: lab ${labId}` })

  // Receipt re-check + atomic swap under lock #2. The swap itself is the
  // only critical section: the post-promote snapshot, restart verification
  // and any rollback run outside it (each snapshot acquires its own writer
  // lock, which this process must not hold twice).
  const lock2 = await acquireLock({
    lockPath: profileLockPath(ctx.home, ctx.profileName),
    purpose: `promote lab ${labId} (swap)`,
    breakStale: ctx.breakStaleLock,
    now: ctx.now(),
  })
  let applied: string[] = []
  let afterIdRef: string | null = null
  try {
    const current = await analyzeProfileNow(ctx)
    if (current.receipt.tree !== manifest.source.receipt) {
      throw new UsageError(
        'official profile changed between the pre-promote snapshot and the swap — ' +
          'promotion aborted (nothing was written)',
      )
    }
    const swap = await transactionalReplaceFiles(
      officialDir,
      WHITELIST_FILE_NAMES,
      labSourceOf(labProfileDirPath),
    )
    applied = swap.applied
  } finally {
    await lock2.release()
  }
  try {
    const afterResult = await runSnapshotCreate(ctx, { label: `post-promote: lab ${labId}` })
    const afterId = afterResult.id
    afterIdRef = afterId
    const receiptAfter = (await analyzeProfileNow(ctx)).receipt.tree
    let lkgId: string | null = null
    let restartVerified = false

    if (options.restart === true) {
      // --restart: install the candidate's dependencies into the official
      // profile (derived node_modules — never copied from the lab), boot the
      // official profile, then require a full client probe.
      const installImpl = options.deps?.install ?? runCaptured
      for (const step of manifest.plan) {
        if (step.action !== 'add' && step.action !== 'update' && step.action !== 'remove') {
          continue
        }
        const verb = step.action === 'add' ? 'add' : step.action === 'update' ? 'update' : 'remove'
        const argv = [verb]
        if (step.action !== 'remove' && step.spec !== undefined) argv.push(step.spec)
        if (step.action === 'remove' && step.id !== undefined) argv.push(step.id)
        if (step.action !== 'remove') argv.push('--ignore-scripts')
        const installOutcome = await installImpl(
          host.binary.path,
          ['plugin', '--profile', ctx.profileName, ...argv],
          {
            cwd: officialDir,
            env: { ...ctx.env, DSH_HOME: ctx.home },
            timeoutMs: 300_000,
          },
        )
        if (installOutcome.exitCode !== 0 || installOutcome.spawnError !== null) {
          const tail = (installOutcome.stderr || installOutcome.stdout || '')
            .trim()
            .split('\n')
            .filter(Boolean)
            .slice(-3)
          throw new Error(
            `installing the candidate on the official profile failed ` +
              `(${installOutcome.spawnError ?? `exit ${String(installOutcome.exitCode)}`}): ` +
              `${redactText(tail.join(' | ') || 'no output')} — rolling back`,
          )
        }
      }
      const launchImpl = options.deps?.launch ?? launchDsh
      const clientProbeImpl = options.deps?.clientProbe ?? runClientProbe
      const launchResult = await launchImpl({
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: ctx.home,
        env: { ...ctx.env, DSH_HOME: ctx.home },
        readyTimeoutMs: 120_000,
      })
      if (launchResult.kind !== 'ready' || launchResult.handle === undefined) {
        throw new Error(
          `official profile did not boot after promote — rolling back ` +
            `(host: ${redactText(launchResult.detail)})`,
        )
      }
      let probeOutcome
      try {
        probeOutcome = await clientProbeImpl({ url: launchResult.handle.url })
      } finally {
        await launchResult.handle.stop().catch(() => null)
      }
      if (probeOutcome.signal.kind !== 'ready') {
        throw new Error(`restart verification failed (${probeOutcome.signal.kind}) — rolling back`)
      }
      lkgId = afterId
      restartVerified = true
      await noteLastKnownGood(ctx.home, ctx.profileName, lkgId)
    }

    await appendJournal(ctx.home, {
      id: journalId,
      kind: 'promotion',
      createdAt: ctx.now().toISOString(),
      profileName: ctx.profileName,
      labId,
      preSnapshot: pre.id,
      afterSnapshot: afterId,
      outcome: 'committed',
      receiptBefore: manifest.source.receipt,
      receiptAfter,
      files: applied,
      lastKnownGood: restartVerified,
    })
    return {
      ok: true,
      clientGate,
      preSnapshot: pre.id,
      afterSnapshot: afterId,
      appliedFiles: applied,
      restartVerified,
      lastKnownGood: lkgId,
      journalId,
    }
  } catch (error) {
    // Roll the managed files back to the pre-promote snapshot contents.
    let rollbackSucceeded = false
    try {
      await rollbackManagedFiles(ctx.home, pre.id, officialDir)
      rollbackSucceeded = true
    } catch (rollbackError) {
      const message = error instanceof Error ? error.message : String(error)
      const wrapped = new Error(
        `${message} — and the pre-promote rollback ALSO failed ` +
          `(${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}); ` +
          'manual rescue required',
      )
      if (rollbackError instanceof Error) wrapped.cause = rollbackError
      throw wrapped
    }
    const reason = error instanceof Error ? error.message : String(error)
    const receiptAfter = (await analyzeProfileNow(ctx).catch(() => null))?.receipt.tree ?? ''
    await appendJournal(ctx.home, {
      id: journalId,
      kind: 'promotion',
      createdAt: ctx.now().toISOString(),
      profileName: ctx.profileName,
      labId,
      preSnapshot: pre.id,
      afterSnapshot: afterIdRef,
      outcome: 'rolled-back',
      receiptBefore: manifest.source.receipt,
      receiptAfter,
      files: applied,
      lastKnownGood: false,
      reason: redactText(reason),
    })
    void rollbackSucceeded
    throw error instanceof UsageError
      ? error
      : new Error(
          `promotion failed and was rolled back to the pre-promote snapshot: ${redactText(reason)}`,
        )
  }
}
