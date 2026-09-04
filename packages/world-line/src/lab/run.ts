/**
 * One lab transaction (WORLD-LINE-SPEC §3/§6, Phase 2): apply a single
 * candidate verb against one lab's isolated copy — dsh drives only the lab
 * home, pnpm (through `dsh plugin`) mutates only the lab profile — then run
 * the acceptance probes: compose (static), host boot (process-group safe),
 * and HTTP ready. Every step records ProbeResults; failed labs are kept 7
 * days for diagnostics, successes clean up by default unless `--keep`.
 *
 * The real dsh/pnpm executables are injected (`capture`, `launch`, `httpGet`)
 * so unit tests exercise the full protocol with fixture shims.
 */

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from '../context.js'
import { parsePatchListText, parseProfileManifest } from '../domain/composition.js'
import { InvariantError, UsageError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { summarizeProbes } from '../domain/probe.js'
import { redactText } from '../domain/redaction.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { dshBootArgs, dshPluginArgs } from '../host-adapters/dsh-0.1.x.js'
import type { ComposeProbeInput, CompositionProblem } from './compose.js'
import { runComposeProbe } from './compose.js'
import type { KnownHost } from './gate.js'
import { planNeedsPnpm, requirePnpm } from './gate.js'
import type { RunningDsh } from './launcher.js'
import { launchDsh } from './launcher.js'
import { labHomeDir, labLogDir, labProbePath, labProfileDir, labStoreDir } from './layout.js'
import type { LabManifest, LabPlanRecord } from './manifest.js'
import { isApplying, readLabManifest, writeLabManifest } from './manifest.js'
import type { RunOutcome } from './runner.js'
import { runCaptured } from './runner.js'

export const FAILED_LAB_RETENTION_DAYS = 7

/** Dependencies injected for tests. */
export interface LabRunDeps {
  capture: typeof runCaptured
  launch: typeof launchDsh
  httpGet(url: string): Promise<{ status: number } | { error: string }>
}

export interface LabRunInput {
  ctx: CliContext
  host: KnownHost
  labId: string
  plan: LabPlanRecord[]
  /** Drop the default `--ignore-scripts` (user explicitly allowed scripts). */
  allowScripts?: boolean
  /** Keep the lab after success (default deletes the whole lab). */
  keep?: boolean
  deps?: Partial<LabRunDeps>
}

export interface LabRunOutcome {
  ok: boolean
  probes: ProbeResult[]
  problems: CompositionProblem[]
  /** Lab dir was removed by the default success cleanup. */
  deleted: boolean
  /** Recorded host port of the successful boot, if any. */
  port?: number
}

/** Status-only HTTP probe; the token URL never leaves this function. */
async function defaultHttpGet(url: string): Promise<{ status: number } | { error: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return { status: response.status }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Remove the whole lab dir (manifest, probe.json, home, store, logs). */
export async function rmLab(home: string, labId: string): Promise<void> {
  await rm(join(home, 'world-line', 'labs', labId), { recursive: true, force: true })
}

/** Installed dependency names of the lab profile (missing-package check). */
async function installedPackageNames(profileDir: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(profileDir, 'package.json'), 'utf8')
    const manifest = parseProfileManifest(text, join(profileDir, 'package.json'))
    return new Set(Object.keys(manifest.dependencies))
  } catch {
    return new Set()
  }
}

function stepLabelOf(step: LabPlanRecord): string {
  switch (step.action) {
    case 'add':
      return `candidate ${step.spec ?? step.id ?? '(unnamed)'} is installed into the lab`
    case 'update':
      return `candidate ${step.spec ?? step.id ?? '(unnamed)'} replaces the lab copy`
    case 'remove':
      return `${step.id ?? '(unnamed)'} is removed from the lab`
    case 'config-apply':
      return 'the config patch applies cleanly to the lab profile'
  }
}

function summarizeStepFailure(outcome: RunOutcome): string {
  if (outcome.spawnError !== null)
    return `dsh could not be spawned: ${redactText(outcome.spawnError)}`
  if (outcome.timedOut) return 'dsh plugin timed out and its process group was killed'
  const tail = (outcome.stderr || outcome.stdout).trim().split('\n').filter(Boolean).slice(-3)
  return `dsh plugin exited ${String(outcome.exitCode)} — ${redactText(tail.join(' | ') || 'no output')}`
}

/** pnpm argv for one plan step (spec §6: `--ignore-scripts` is the default;
 * exercised: `pnpm remove` rejects --ignore-scripts, add/update accept it). */
function pnpmArgsFor(step: LabPlanRecord, storeDir: string, allowScripts: boolean): string[] {
  const verb = step.action === 'add' ? 'add' : step.action === 'update' ? 'update' : 'remove'
  const args = [verb]
  if (step.action === 'add' && step.spec !== undefined) args.push(step.spec)
  if (step.action === 'update' && step.spec !== undefined) args.push(step.spec)
  if (step.action === 'remove' && step.id !== undefined) args.push(step.id)
  args.push('--store-dir', storeDir)
  if (!allowScripts && step.action !== 'remove') args.push('--ignore-scripts')
  return args
}

/**
 * Run one transaction against an existing lab; resolves ok=false (verification
 * failure) instead of throwing when a probe fails. Usage/invariant problems
 * still throw their WlError subclasses.
 */
export async function runLabTransaction(input: LabRunInput): Promise<LabRunOutcome> {
  const { ctx, host, labId } = input
  const now = ctx.now()
  const capture = input.deps?.capture ?? runCaptured
  const launch = input.deps?.launch ?? launchDsh
  const httpGet = input.deps?.httpGet ?? defaultHttpGet
  const logDir = labLogDir(ctx.home, labId)
  const logPath = join(logDir, 'dsh.log')
  const profileDir = labProfileDir(ctx.home, labId, ctx.profileName)
  const storeDir = labStoreDir(ctx.home, labId)
  const probes: ProbeResult[] = []
  const problems: CompositionProblem[] = []

  const labEnv: NodeJS.ProcessEnv = {
    ...ctx.env,
    DSH_HOME: labHomeDir(ctx.home, labId),
    WORLD_LINE_LAB: labId,
  }
  const log = async (text: string): Promise<void> => {
    await mkdir(logDir, { recursive: true }).catch(() => {})
    await appendFile(logPath, `${text}\n`).catch(() => {})
  }
  const emit = (entry: ProbeResult): void => {
    probes.push(entry)
  }
  const hasFailures = (): boolean => probes.some((entry) => entry.status === 'fail')

  const manifest0 = await readLabManifest(ctx.home, labId)
  if (manifest0.state === 'destroyed') {
    throw new InvariantError(`lab ${labId} is destroyed — refusing to run`)
  }
  if (isApplying(manifest0)) {
    throw new InvariantError(`lab ${labId} is mid-run (${manifest0.state}) — one run at a time`)
  }
  if (manifest0.source.profileName !== ctx.profileName) {
    throw new UsageError(
      `lab ${labId} was cloned from profile ${manifest0.source.profileName}, not ${ctx.profileName}`,
    )
  }

  const runStartedAt = now.toISOString()
  let manifest: LabManifest = {
    ...manifest0,
    state: 'applying',
    updatedAt: runStartedAt,
    runCount: manifest0.runCount + 1,
    plan: input.plan,
    lastRun: { startedAt: runStartedAt, finishedAt: '', ok: false, exitCode: 1 },
  }
  manifest = await writeLabManifest(ctx.home, manifest, now)
  await log(`run ${manifest.runCount} started ${runStartedAt} — plan ${JSON.stringify(input.plan)}`)

  let booted: RunningDsh | null = null
  let deleted = false

  // ---- 1. Plan steps (dependency mutations through the pnpm forwarder).
  try {
    const needsPnpm = input.plan.some((step) => planNeedsPnpm(step.action))
    if (needsPnpm) {
      const pnpm = requirePnpm(ctx.env)
      await log(`pnpm resolved at ${pnpm.path}`)
    }

    for (const step of input.plan) {
      if (step.action === 'config-apply') continue
      const startedAt = new Date().toISOString()
      const pnpmArgs = pnpmArgsFor(step, storeDir, input.allowScripts ?? false)
      const outcome = await capture(host.binary.path, dshPluginArgs(ctx.profileName, pnpmArgs), {
        cwd: profileDir,
        env: labEnv,
        timeoutMs: 180_000,
      })
      await log(
        `$ dsh plugin ${pnpmArgs.join(' ')}\nexit=${String(outcome.exitCode)} signal=${String(
          outcome.signal,
        )}\n${outcome.stdout}${outcome.stderr}`,
      )
      const ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut
      const base: ProbeResult = {
        check: `plugin-${step.action}`,
        label: stepLabelOf(step),
        required: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: ok ? 'pass' : 'fail',
        ...(step.id !== undefined ? { entries: [step.id] } : {}),
      }
      emit(ok ? base : { ...base, detail: summarizeStepFailure(outcome) })
      if (ok && !(input.allowScripts ?? false)) {
        const notice = /ignored build scripts|approve-builds/i.exec(
          `${outcome.stdout}\n${outcome.stderr}`,
        )
        if (notice !== null) {
          emit({
            check: `plugin-${step.action}`,
            label: 'packages needing build scripts are reported (requires-script)',
            required: false,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: 'warn',
            detail: `${notice[0]} — re-run with --allow-scripts (not a sandbox)`,
            ...(step.id !== undefined ? { entries: [step.id] } : {}),
          })
        }
      }
    }

    // ---- 2. Compose probe (config-apply overlays ride the same dump).
    const overlayStep = input.plan.find((step) => step.action === 'config-apply')
    let overlayParsed: unknown[] | undefined
    if (overlayStep?.overlayPath !== undefined) {
      const text = await readFile(overlayStep.overlayPath, 'utf8').catch(() => null)
      if (text === null) {
        throw new UsageError(`config patch ${overlayStep.overlayPath} vanished before the run`)
      }
      try {
        overlayParsed = parsePatchListText(text, overlayStep.overlayPath)
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
      }
    }
    const composeInput: Omit<ComposeProbeInput, 'run'> = {
      dshBinary: host.binary.path,
      profileName: ctx.profileName,
      ...(overlayStep?.overlayPath !== undefined ? { overlayPath: overlayStep.overlayPath } : {}),
      ...(overlayParsed !== undefined
        ? { overlayParsed, installedNames: await installedPackageNames(profileDir) }
        : {}),
      env: labEnv,
      cwd: profileDir,
    }
    if (!hasFailures()) {
      const composeOutcome = await runComposeProbe({
        ...composeInput,
        run: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
          capture(host.binary.path, args, { ...options, timeoutMs: 60_000 }),
      })
      probes.push(...composeOutcome.probes)
      problems.push(...composeOutcome.problems)
    }

    // ---- 3. Host boot + HTTP ready.
    if (!hasFailures()) {
      const bootStartedAt = new Date().toISOString()
      const launchResult = await launch({
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: labHomeDir(ctx.home, labId),
        env: labEnv,
        readyTimeoutMs: 120_000,
      })
      if (launchResult.kind !== 'ready' || launchResult.handle === undefined) {
        emit({
          check: 'host-boot',
          label: 'the lab dsh boots to the ready line',
          required: true,
          startedAt: bootStartedAt,
          finishedAt: new Date().toISOString(),
          status: 'fail',
          detail: redactText(launchResult.detail),
        })
        await log(`boot failed: ${launchResult.detail}`)
      } else {
        booted = launchResult.handle
        const httpStartedAt = new Date().toISOString()
        const httpResult = await httpGet(booted.url)
        const httpOk = 'status' in httpResult && httpResult.status < 500
        emit({
          check: 'http-ready',
          label: 'the lab ready URL answers HTTP (hostReady)',
          required: true,
          startedAt: httpStartedAt,
          finishedAt: new Date().toISOString(),
          status: httpOk ? 'pass' : 'fail',
          ...(httpOk
            ? {}
            : { detail: 'error' in httpResult ? httpResult.error : `HTTP ${httpResult.status}` }),
        })
        emit({
          check: 'host-boot',
          label: 'the lab dsh boots to the ready line',
          required: true,
          startedAt: bootStartedAt,
          finishedAt: new Date().toISOString(),
          status: 'pass',
          ...(booted.port > 0 ? { detail: `listening on loopback port ${booted.port}` } : {}),
        })
      }
    }
  } finally {
    if (booted !== null) {
      const transcript = await booted.stop().catch(() => null)
      if (transcript !== null) {
        await log(transcript.stdout).catch(() => {})
        await log(transcript.stderr).catch(() => {})
      }
    }
  }

  // ---- 4. Verdict + persistence (§3: successes clean up by default,
  // failures keep diagnostics 7 days; --keep retains a successful lab).
  const summary = summarizeProbes(probes)
  const ok = summary.ok
  const finishedAt = new Date().toISOString()
  const keep = input.keep ?? false
  const survives = !ok || keep
  const retention: LabManifest['retention'] = ok
    ? { cleanupMode: keep ? 'keep-on-failure' : 'delete-on-success' }
    : {
        cleanupMode: 'keep-on-failure',
        expiresAt: new Date(now.getTime() + FAILED_LAB_RETENTION_DAYS * 86_400_000).toISOString(),
      }
  const finalManifest: LabManifest = {
    ...manifest,
    state: ok ? 'passed' : 'failed',
    retention,
    lastRun: {
      startedAt: runStartedAt,
      finishedAt,
      ok,
      exitCode: ok ? 0 : 1,
      ...(booted !== null && booted.port > 0 ? { port: booted.port } : {}),
    },
  }

  if (survives) {
    await writeLabManifest(ctx.home, finalManifest, new Date(finishedAt))
    const probeJson = `${JSON.stringify({ labId, finishedAt, summary, probes }, null, 2)}\n`
    await writeFileAtomic(labProbePath(ctx.home, labId), probeJson)
  } else {
    deleted = true
    // Log first: the cleanup line must land inside the dir that is about to go.
    await log('default cleanup: successful lab deleted (use --keep to retain)').catch(() => {})
    await rmLab(ctx.home, labId)
  }

  const outcome: LabRunOutcome = {
    ok,
    probes,
    problems,
    deleted,
    ...(booted !== null && booted.port > 0 ? { port: booted.port } : {}),
  }
  return outcome
}
