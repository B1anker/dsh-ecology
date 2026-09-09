import { JSON_SCHEMA, load } from 'js-yaml'
import { withOperations } from '../fs/operation.js'
import { rebaseHomePaths } from './home-inheritance.js'
import { labHomeDir } from './layout.js'
import { sourceContext } from './source.js'
import {
  type PromotionTransaction,
  prepareTransaction,
  rollbackTransactionFiles,
  saveTransaction,
  settleTransaction,
  type TransactionPhase,
} from './transaction.js'

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
 *   5. optional --restart: install/boot and require a full client probe,
 *   6. capture the final after-snapshot, durably decide commit, then reconcile
 *      the stable point and idempotent journal. Before the decision, failures
 *      restore exact private backups when hashes permit. Unknown runtime/file
 *      states require explicit recovery; they are never reported as rolled back.
 *
 * Promote never copies lab runtime, logs, cookies, tokens or the lab home.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSnapshotCreate } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { UsageError, VerificationError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { redactText } from '../domain/redaction.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { adapterDsh01x, dshBootArgs } from '../host-adapters/dsh-0.1.x.js'
import { runClientProbe } from './browser.js'
import { WHITELIST_FILE_NAMES } from './create.js'
import type { KnownHost } from './gate.js'
import { requireKnownHost } from './gate.js'
import { newJournalId } from './journal.js'
import { launchDsh } from './launcher.js'
import { labExists, labLogDir, labProbePath, labProfileDir } from './layout.js'
import type { LabManifest } from './manifest.js'
import { readLabManifest } from './manifest.js'
import { runCaptured } from './runner.js'
import { labStorePolicy } from './store.js'
import { transactionalReplaceFiles } from './swap.js'

export type ClientGate = 'pass' | 'fail' | 'inconclusive'

/** Classify lab probe records for the promotion client gate (§6). */
export function classifyClientGate(probes: readonly ProbeResult[]): ClientGate {
  // v2 has a single independently evidenced browser check and explicit coverage.
  if (probes.some((p) => p.check === 'plugin-function')) {
    const required = probes.filter((p) => p.required)
    if (required.some((p) => p.status === 'fail')) return 'fail'
    return required.some((p) => p.check === 'browser-boot') &&
      required.every((p) => p.status === 'pass')
      ? 'pass'
      : 'inconclusive'
  }
  const relevant = probes.filter((entry) =>
    ['browser-boot', 'core-contract', 'candidate-contract'].includes(entry.check),
  )
  if (relevant.length === 0) return 'inconclusive'
  if (relevant.some((entry) => entry.status === 'fail')) return 'fail'
  if (
    ['browser-boot', 'core-contract', 'candidate-contract'].every((check) =>
      relevant.some((entry) => entry.check === check && entry.status === 'pass'),
    ) &&
    relevant.every((entry) => entry.status === 'pass')
  )
    return 'pass'
  return 'inconclusive'
}

/** Only unknown-impact observations can be accepted, never missing core proof. */
export function canAcceptReview(probes: readonly ProbeResult[]): boolean {
  return (
    ['browser-boot', 'plugin-function', 'client-observations'].every((check) =>
      probes.some((p) => p.check === check),
    ) &&
    probes.some((p) => p.check === 'client-observations' && p.status === 'inconclusive') &&
    probes.every(
      (p) =>
        !p.required ||
        p.status === 'pass' ||
        (p.check === 'client-observations' && p.status === 'inconclusive'),
    )
  )
}

export interface LabPromoteOptions {
  /** Explicit per-run user review; never set by automatic verification flows. */
  acceptReview?: boolean
  labId: string
  /** Accept inconclusive client evidence (never `fail`). */
  acceptInconclusive?: boolean
  /** Boot the official profile after the swap and require a full client probe. */
  restart?: boolean
  /** Progress hook: fired at phase boundaries (web job ladder; ids are stable). */
  onPhase?: (phase: string) => void
  onTransaction?: (id: string) => void
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
  restartPendingReason?: string
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
/**
 * Source of the swap: read one managed file from the lab profile. A lab may
 * legitimately lack a whitelisted file — a restore lab materializes only the
 * files the snapshot holds (e.g. a fresh profile has no pnpm-lock.yaml yet)
 * — and `null` makes the swap *delete* that managed file from the official
 * profile, keeping both sides byte-faithful to the verified state.
 */
function labSourceOf(labProfileDirPath: string) {
  return async (name: string): Promise<Buffer | null> => {
    try {
      return await readFile(`${labProfileDirPath}/${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
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
  const manifest = await readLabManifest(ctx.home, options.labId)
  const source = await sourceContext(ctx, manifest.source.parentLabId)
  return withOperations(
    [source.home, labHomeDir(ctx.home, options.labId)],
    ctx.profileName,
    () => runLabPromoteUnlocked(ctx, options),
    ctx.breakStaleLock,
  )
}
async function runLabPromoteUnlocked(
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
  if (manifest.hostExperiment)
    throw new UsageError('版本矩阵实验不能直接合入；请先升级宿主适配认证并重新验证')
  if (manifest.purpose === 'mirror')
    throw new UsageError(
      'interactive mirrors cannot be promoted; use lab add/config verification instead',
    )
  const labProfileName = manifest.source.profileName
  const journalKind = manifest.source.kind === 'restore' ? 'restore' : 'promotion'
  if (labProfileName !== ctx.profileName) {
    throw new UsageError(
      `lab ${labId} cloned profile ${JSON.stringify(labProfileName)}; ` +
        `promoting requires --profile ${labProfileName}`,
    )
  }
  options.onPhase?.('gate')
  const probes = await readLabProbeProbes(ctx.home, labId)
  const reviewAccepted = options.acceptReview === true && canAcceptReview(probes)
  if (manifest.state !== 'passed' && !(manifest.state === 'failed' && reviewAccepted)) {
    throw new UsageError(`实验 ${labId} 尚未通过必要检查，请先补充验证。`)
  }

  if (probes.some((p) => p.check === 'plugin-function')) {
    const evidence = JSON.parse(await readFile(labProbePath(ctx.home, labId), 'utf8'))
    const candidate = await analyzeProfileNow({ ...ctx, home: labHomeDir(ctx.home, labId) })
    if (
      evidence.policyVersion !== 2 ||
      evidence.candidateReceipt !== candidate.receipt.tree ||
      evidence.sourceReceipt !== manifest.source.receipt ||
      evidence.hostVersion !== host.raw
    ) {
      throw new VerificationError('实验内容、来源或宿主版本与验证记录不一致，请重新验证后合入。')
    }
  }
  const clientGate = classifyClientGate(probes)
  if (clientGate === 'fail') {
    throw new VerificationError(
      `lab ${labId} failed its client probes — promotion is refused ` +
        '(--accept-inconclusive never overrides a client failure)',
    )
  }
  if (clientGate === 'inconclusive' && !reviewAccepted) {
    throw new VerificationError(
      `实验 ${labId} 缺少完整的浏览器验证，尚不能合入来源环境。请点击「登录并补做浏览器验证」，通过后再合入。`,
    )
  }

  const storageHome = ctx.home
  // The lab's node_modules is linked to World Line's managed pnpm store. The
  // post-swap install must keep using that store, otherwise pnpm correctly
  // refuses to mix it with the user's global store and the promotion rolls back.
  const store = labStorePolicy(storageHome, manifest)
  ctx = await sourceContext(ctx, manifest.source.parentLabId)
  const officialDir = profileDir(ctx.home, ctx.profileName)
  const labProfileDirPath = labProfileDir(storageHome, labId, labProfileName)
  const homeConfig = async (home: string) => {
    const text = await readFile(join(home, 'cordis.patch.yml'), 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    return text === null
      ? null
      : rebaseHomePaths(load(text, { schema: JSON_SCHEMA }), home, ctx.home)
  }
  if (
    JSON.stringify(await homeConfig(ctx.home)) !==
    JSON.stringify(await homeConfig(labHomeDir(storageHome, labId)))
  )
    throw new UsageError(
      '实验包含不同的 home 全局配置。请在「排障与交付」准备完整部署并切换；profile 合入不能覆盖其他 profile 的全局配置。',
    )
  const journalId = newJournalId(ctx.now(), journalKind)

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
  options.onPhase?.('pre-snapshot')
  const pre = await runSnapshotCreate(ctx, { label: `pre-promote: lab ${labId}` })

  const record: PromotionTransaction = {
    version: 1,
    id: journalId,
    profileName: ctx.profileName,
    managerHome: storageHome,
    ...(manifest.source.parentLabId && manifest.source.parentLabId !== 'origin'
      ? { parentLabId: manifest.source.parentLabId }
      : {}),
    labId,
    phase: 'prepared',
    preSnapshot: pre.id,
    afterSnapshot: null,
    files: [],
    entry: {
      id: journalId,
      kind: journalKind,
      createdAt: ctx.now().toISOString(),
      profileName: ctx.profileName,
      labId,
      preSnapshot: pre.id,
      afterSnapshot: null,
      outcome: 'rolled-back',
      receiptBefore: manifest.source.receipt,
      receiptAfter: manifest.source.receipt,
      files: [...WHITELIST_FILE_NAMES],
      lastKnownGood: false,
      ...(reviewAccepted
        ? {
            reviewAcceptance: {
              acceptedAt: ctx.now().toISOString(),
              policyVersion: 2 as const,
              unresolvedChecks: ['client-observations'],
              labId,
            },
          }
        : {}),
      ...(journalKind === 'restore' && manifest.source.kind === 'restore'
        ? { snapshotId: manifest.source.snapshotId }
        : {}),
    },
  }
  const checkpoint = async (phase: TransactionPhase) => {
    record.phase = phase
    await saveTransaction(ctx.home, record)
    options.onPhase?.(phase)
  }
  let prepared = false
  let commitDecisionStarted = false
  let runtimeMayBeActive = false
  try {
    const lock2 = await acquireLock({
      lockPath: profileLockPath(ctx.home, ctx.profileName),
      purpose: `promote lab ${labId} (swap)`,
      breakStale: ctx.breakStaleLock,
      now: ctx.now(),
    })
    try {
      const current = await analyzeProfileNow(ctx)
      if (current.receipt.tree !== manifest.source.receipt)
        throw new UsageError(
          'official profile changed between the pre-promote snapshot and the swap — promotion aborted (nothing was written)',
        )
      await prepareTransaction(ctx.home, record, labProfileDirPath)
      prepared = true
      options.onTransaction?.(record.id)
      await checkpoint('swapping')
      options.onPhase?.('swap')
      await transactionalReplaceFiles(
        officialDir,
        WHITELIST_FILE_NAMES,
        labSourceOf(labProfileDirPath),
      )
      await checkpoint('swapped')
    } finally {
      await lock2.release()
    }
    let restartVerified = false
    if (options.restart === true) {
      // --restart: install the candidate's dependencies into the official
      // profile (derived node_modules — never copied from the lab), boot the
      // official profile, then require a full client probe.
      await checkpoint('installing')
      options.onPhase?.('restart-verify')
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
        runtimeMayBeActive = true
        const installOutcome = await installImpl(
          host.binary.path,
          ['plugin', '--profile', ctx.profileName, ...argv],
          {
            cwd: officialDir,
            env: { ...store.environment(ctx.env), DSH_HOME: ctx.home },
            timeoutMs: 300_000,
          },
        )
        runtimeMayBeActive = false
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
      await checkpoint('verifying')
      const launchImpl = options.deps?.launch ?? launchDsh
      const clientProbeImpl = options.deps?.clientProbe ?? runClientProbe
      runtimeMayBeActive = true
      const launchResult = await launchImpl({
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: ctx.home,
        env: { ...ctx.env, DSH_HOME: ctx.home },
        readyTimeoutMs: 120_000,
      })
      if (launchResult.kind !== 'ready' || launchResult.handle === undefined) {
        runtimeMayBeActive = false
        throw new Error(
          `official profile did not boot after promote — rolling back ` +
            `(host: ${redactText(launchResult.detail)})`,
        )
      }
      let probeOutcome
      try {
        probeOutcome = await clientProbeImpl({
          url: launchResult.handle.url,
          artifactRoot: join(labLogDir(storageHome, labId), 'browser-artifacts'),
          artifactContext: 'promotion-restart',
        })
      } finally {
        await launchResult.handle.stop()
        runtimeMayBeActive = false
      }
      if (probeOutcome.signal.kind === 'fail') {
        throw new Error(`restart verification failed (${probeOutcome.signal.kind}) — rolling back`)
      }
      restartVerified = !reviewAccepted && probeOutcome.signal.kind === 'ready'
      if (!restartVerified)
        record.entry.reason =
          '变更已提交；重启后的浏览器验证缺少完整证据，请完成登录或补充验证。未标记稳定点。'
    }

    await checkpoint('verified')
    options.onPhase?.('after-snapshot')
    const after = await runSnapshotCreate(ctx, {
      label: `post-promote: lab ${labId}`,
      transactionId: record.id,
    })
    record.afterSnapshot = after.id
    record.entry.afterSnapshot = after.id
    record.entry.receiptAfter = (await analyzeProfileNow(ctx)).receipt.tree
    record.entry.outcome = 'committed'
    record.entry.lastKnownGood = restartVerified
    const result: LabPromoteResult = {
      ok: true,
      clientGate,
      ...(record.entry.reason ? { restartPendingReason: record.entry.reason } : {}),
      preSnapshot: pre.id,
      afterSnapshot: after.id,
      appliedFiles: [...WHITELIST_FILE_NAMES],
      restartVerified,
      lastKnownGood: restartVerified ? after.id : null,
      journalId,
    }
    record.result = result
    await checkpoint('snapshotted')
    // Once this decision may be on disk, never roll back on metadata failures.
    commitDecisionStarted = true
    await checkpoint('committing')
    options.onPhase?.('journal')
    await withOperations(
      [ctx.home],
      'vault',
      () => settleTransaction(ctx.home, record, ctx.breakStaleLock),
      ctx.breakStaleLock,
    )
    options.onPhase?.('committed')
    return result
  } catch (error) {
    if (!prepared) throw error
    if (runtimeMayBeActive)
      throw new Error(
        `promotion runtime shutdown is unconfirmed: ${record.id}; stop the installer/verification process before recovery`,
        { cause: error },
      )
    if (commitDecisionStarted)
      throw new Error(
        `promotion decision requires reconciliation: ${record.id}; run recovery reconcile ${record.id} --yes`,
        { cause: error },
      )
    try {
      const rollbackLock = await acquireLock({
        lockPath: profileLockPath(ctx.home, ctx.profileName),
        purpose: 'rollback promotion',
        breakStale: ctx.breakStaleLock,
      })
      try {
        await rollbackTransactionFiles(ctx.home, record)
      } finally {
        await rollbackLock.release()
      }
      record.entry.outcome = 'rolled-back'
      record.entry.lastKnownGood = false
      record.entry.receiptAfter = (await analyzeProfileNow(ctx)).receipt.tree
      record.entry.reason = redactText(error instanceof Error ? error.message : String(error))
      await saveTransaction(ctx.home, record)
      await withOperations(
        [ctx.home],
        'vault',
        () => settleTransaction(ctx.home, record, ctx.breakStaleLock),
        ctx.breakStaleLock,
      )
    } catch (recoveryError) {
      throw new Error(
        `promotion recovery incomplete: ${record.id}; original files retained for recovery`,
        { cause: new AggregateError([error, recoveryError]) },
      )
    }
    throw new Error(
      `promotion failed and was rolled back to the original managed files: ${redactText(error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    )
  }
}
