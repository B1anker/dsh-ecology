import { randomBytes } from 'node:crypto'
import { analyzeProfile } from '../domain/snapshot.js'
import { withOperations } from '../fs/operation.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { withPackageCache } from './cache-maintenance.js'
import { checkCoreBaseline } from './core-baseline.js'
import { parseCandidateSpec } from './plans.js'
import { labStorePolicy } from './store.js'
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
import type { BrowserProbeDeps } from './browser.js'
import { runClientProbe } from './browser.js'
import type { ComposeProbeInput, CompositionProblem } from './compose.js'
import { runComposeProbe } from './compose.js'
import type { KnownHost } from './gate.js'
import { planNeedsPnpm, requirePnpm } from './gate.js'
import type { RunningDsh } from './launcher.js'
import { launchDsh } from './launcher.js'
import { labHomeDir, labLogDir, labProbePath, labProfileDir } from './layout.js'
import type { LabManifest, LabPlanRecord } from './manifest.js'
import { isApplying, readLabManifest, writeLabManifest } from './manifest.js'
import type { RunOutcome } from './runner.js'
import { runCaptured } from './runner.js'

export const FAILED_LAB_RETENTION_DAYS = 7

/** Dependencies injected for tests. */
export interface LabRunDeps {
  coreCheck?: ComposeProbeInput['coreCheck']

  /** Browser launcher for the client probes (tests inject a fake). */
  browserLaunch?: BrowserProbeDeps['launch']
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
  /**
   * Run the browser client probes (§6 steps 4-6). Plain lab verification is
   * offline-friendly and skips them; promotion-bound runs enable this so the
   * client gate has real evidence.
   */
  clientProbes?: boolean
  interactive?: boolean
  /** Recheck installed contents without resolving or installing candidates again. */
  verifyOnly?: boolean
  /**
   * With --accept-inconclusive: a browser probe without a reliable signal is
   * demoted to a warning so the run can proceed to the promotion gate, which
   * then accepts it explicitly. Client failures are never demoted.
   */
  acceptClientInconclusive?: boolean
  /** Progress hook: receives each probe as it is recorded (web job ladder). */
  onPhase?: (phase: string) => void
  onProbe?: (probe: ProbeResult) => void
  deps?: Partial<LabRunDeps>
}

export type ClientReadyState = 'pass' | 'fail' | 'inconclusive' | 'skipped'

export interface LabRunOutcome {
  ok: boolean
  probes: ProbeResult[]
  problems: CompositionProblem[]
  /** Lab dir was removed by the default success cleanup. */
  deleted: boolean
  /** Recorded host port of the successful boot, if any. */
  port?: number
  /** Client probes verdict when they ran (§6 steps 4-6). */
  clientReady?: ClientReadyState
}

/** Status-only HTTP probe; the token URL never leaves this function. */
async function defaultHttpGet(url: string): Promise<{ status: number } | { error: string }> {
  try {
    const response = await fetch(new URL('/', url), { signal: AbortSignal.timeout(10_000) })
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
export function pnpmArgsFor(
  step: LabPlanRecord,
  storeFlags: string[],
  allowScripts: boolean,
): string[] {
  const verb = step.action === 'add' ? 'add' : step.action === 'update' ? 'update' : 'remove'
  const args = [verb]
  if (step.action === 'add' && step.spec !== undefined) {
    const candidate = parseCandidateSpec(step.spec)
    args.push(!candidate.localPath && !candidate.version ? `${candidate.name}@latest` : step.spec)
  }
  if (step.action === 'update' && step.spec !== undefined) args.push(step.spec)
  if (step.action === 'remove' && step.id !== undefined) args.push(step.id)
  args.push(...storeFlags)
  if (!allowScripts && step.action !== 'remove') args.push('--ignore-scripts')
  return args
}

/**
 * Run one transaction against an existing lab; resolves ok=false (verification
 * failure) instead of throwing when a probe fails. Usage/invariant problems
 * still throw their WlError subclasses.
 */
export async function runLabTransaction(input: LabRunInput): Promise<LabRunOutcome> {
  return withOperations(
    [labHomeDir(input.ctx.home, input.labId)],
    input.ctx.profileName,
    () => withPackageCache(input.ctx.home, () => runLabTransactionUnlocked(input)),
    input.ctx.breakStaleLock,
  )
}
async function runLabTransactionUnlocked(input: LabRunInput): Promise<LabRunOutcome> {
  const { ctx, host, labId } = input
  const now = ctx.now()
  const capture = input.deps?.capture ?? runCaptured
  const launch = input.deps?.launch ?? launchDsh
  const httpGet = input.deps?.httpGet ?? defaultHttpGet
  const logDir = labLogDir(ctx.home, labId)
  const logPath = join(logDir, 'dsh.log')
  const profileDir = labProfileDir(ctx.home, labId, ctx.profileName)
  const manifest0 = await readLabManifest(ctx.home, labId)
  const store = labStorePolicy(ctx.home, manifest0)
  const probes: ProbeResult[] = []
  const problems: CompositionProblem[] = []

  const labEnv: NodeJS.ProcessEnv = {
    ...store.environment(ctx.experimentEnv ?? ctx.env),
    npm_config_ignore_scripts: input.allowScripts ? 'false' : 'true',
    pnpm_config_ignore_scripts: input.allowScripts ? 'false' : 'true',
    DSH_HOME: labHomeDir(ctx.home, labId),
    WORLD_LINE_LAB: labId,
    WORLD_LINE_MANAGER_HOME: ctx.home,
  }
  // Only an authenticated, same-origin Web action can request delegation.
  // The secret is created after install/compose and passed only to the DSH child.
  delete labEnv.WORLD_LINE_SESSION_SECRET
  delete labEnv.WORLD_LINE_SESSION_EXPIRES
  let delegation: { cookie: { name: string; value: string }; expires: number } | undefined
  const log = async (text: string): Promise<void> => {
    await mkdir(logDir, { recursive: true }).catch(() => {})
    await appendFile(logPath, `${text}\n`).catch(() => {})
  }
  const emit = (entry: ProbeResult): void => {
    probes.push(entry)
    input.onProbe?.(entry)
  }
  const hasFailures = (): boolean => probes.some((entry) => entry.status === 'fail')

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

  if (input.verifyOnly) {
    const prior = await readFile(labProbePath(ctx.home, labId), 'utf8')
      .then((text) => (JSON.parse(text) as { probes: ProbeResult[] }).probes)
      .catch(() => [] as ProbeResult[])
    for (const step of input.plan.filter((item) => item.action !== 'config-apply')) {
      const evidence = prior.find(
        (probe) =>
          probe.check === `plugin-${step.action}` &&
          probe.status === 'pass' &&
          (!step.id || probe.entries?.includes(step.id)),
      )
      if (!evidence) throw new UsageError('原安装步骤未完成，无法只重验；请修改规格并重新安装。')
      emit({ ...evidence, detail: '沿用本实验已完成的安装步骤；未重新安装或解析版本。' })
    }
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
    input.onPhase?.(
      input.verifyOnly ? '读取已安装的实验，准备重新验证' : '准备依赖安装工具与隔离目录',
    )
    const needsPnpm = !input.verifyOnly && input.plan.some((step) => planNeedsPnpm(step.action))
    // The pnpm gate guards the *real* forwarder only: transactions that inject
    // a fake capture (unit tests) never spawn pnpm, so requiring pnpm on the
    // ambient PATH there would make the suite environment-dependent.
    const usingRealForwarder = input.deps?.capture === undefined
    if (needsPnpm && usingRealForwarder) {
      const pnpm = requirePnpm(ctx.env)
      await log(`pnpm resolved at ${pnpm.path}`)
    }

    if (!input.verifyOnly && !needsPnpm && manifest0.packageStore === 'shared-copy-v1') {
      const startedAt = new Date().toISOString()
      const initial = await capture(
        usingRealForwarder ? requirePnpm(ctx.env).path : 'pnpm',
        ['install', '--prod', ...store.flags, ...(input.allowScripts ? [] : ['--ignore-scripts'])],
        { cwd: profileDir, env: labEnv, timeoutMs: 180000 },
      )
      const ok = initial.exitCode === 0 && !initial.spawnError && !initial.timedOut
      emit({
        check: 'dependency-install',
        label: '准备独立依赖目录',
        required: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: ok ? 'pass' : 'fail',
        detail: ok ? '依赖已准备' : '依赖安装失败，请查看实验日志',
      })
      await log(redactText(initial.stdout + initial.stderr))
    }
    for (const step of input.verifyOnly ? [] : input.plan) {
      if (step.action === 'config-apply') continue
      const startedAt = new Date().toISOString()
      input.onPhase?.(
        `正在${step.action === 'remove' ? '卸载' : step.action === 'update' ? '升级' : '安装'} ${step.spec ?? step.id ?? '插件'}，等待依赖处理完成`,
      )
      const pnpmArgs = pnpmArgsFor(step, store.flags, input.allowScripts ?? false)
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
      let ok = outcome.exitCode === 0 && outcome.spawnError === null && !outcome.timedOut
      let resolutionError: string | undefined
      if (ok && step.action === 'add' && step.spec) {
        const candidate = parseCandidateSpec(step.spec)
        if (!candidate.localPath) {
          const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
          const declared = installed.dependencies?.[candidate.name]
          if (typeof declared === 'string' && /^(file|link|workspace):/.test(declared)) {
            ok = false
            resolutionError = '仓库安装没有替换原有本地依赖，实验未通过；来源环境未改动。'
          }
        }
      }
      const base: ProbeResult = {
        check: `plugin-${step.action}`,
        label: stepLabelOf(step),
        required: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: ok ? 'pass' : 'fail',
        ...(step.id !== undefined ? { entries: [step.id] } : {}),
      }
      emit(ok ? base : { ...base, detail: resolutionError ?? summarizeStepFailure(outcome) })
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
      coreCheck: input.deps?.coreCheck ?? ((candidate) => checkCoreBaseline(ctx, host, candidate)),
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
      input.onPhase?.('检查插件依赖和配置组合，确认核心界面没有缺失')
      const composeOutcome = await runComposeProbe({
        ...composeInput,
        run: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
          capture(host.binary.path, args, { ...options, timeoutMs: 60_000 }),
      })
      for (const probe of composeOutcome.probes) emit(probe)
      problems.push(...composeOutcome.problems)
    }

    // ---- 3. Host boot + HTTP ready.
    if (!hasFailures()) {
      const bootStartedAt = new Date().toISOString()
      input.onPhase?.('启动实验 DSH，等待服务就绪')
      if (ctx.authenticatedWebAction)
        delegation = {
          cookie: {
            name: `wl_lab_${labId.replace(/-/g, '_')}`,
            value: randomBytes(32).toString('hex'),
          },
          expires: Date.now() + 10 * 60_000,
        }
      const launchResult = await launch({
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: labHomeDir(ctx.home, labId),
        env: {
          ...labEnv,
          ...(delegation
            ? {
                WORLD_LINE_SESSION_SECRET: delegation.cookie.value,
                WORLD_LINE_SESSION_EXPIRES: String(delegation.expires),
              }
            : {}),
        },
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
        if (launchResult.transcript)
          await log(
            redactText(launchResult.transcript.stdout + '\n' + launchResult.transcript.stderr),
          )
      } else {
        booted = launchResult.handle
        const httpStartedAt = new Date().toISOString()
        const httpResult = await httpGet(booted.url)
        const httpOk =
          'status' in httpResult &&
          ((httpResult.status >= 200 && httpResult.status < 400) ||
            httpResult.status === 401 ||
            httpResult.status === 403)
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

    // ---- 3b. Browser boot + client probes (§6 steps 4-6, Phase 3). Plain
    // runs skip these unless the caller opts in (promotion-bound runs do);
    // no browser executable yields skip probes — never fabricated readiness.
    if (input.clientProbes === true && booted !== null && !hasFailures()) {
      input.onPhase?.(
        input.interactive
          ? '正在本机浏览器验证；如出现登录页，请在该窗口完成登录'
          : '正在打开隔离浏览器，等待页面资源加载并检查核心界面',
      )
      const clientStartedAt = new Date().toISOString()
      const clientOutcome = await runClientProbe({
        url: booted.url,
        artifactRoot: join(labLogDir(ctx.home, labId), 'browser-artifacts'),
        artifactContext: 'lab-verification',
        readyTimeoutMs: input.interactive ? 300_000 : 90_000,
        interactive: input.interactive,
        keepResultWindow: ctx.authenticatedWebAction === true,
        onPhase: input.onPhase,
        ...(delegation ? { delegatedSession: true } : {}),
        ...(input.deps?.browserLaunch !== undefined
          ? { deps: { launch: input.deps.browserLaunch } }
          : {}),
      })
      const signal = clientOutcome.signal
      const finishedAt = new Date().toISOString()
      const detailOf = (): string => {
        switch (signal.kind) {
          case 'ready':
            return `shell settled after ${signal.settledMs} ms (${signal.state.bootEntries} boot entries)`
          case 'fail':
            return redactText(
              `${signal.errors.length} client error(s): ${signal.errors.slice(0, 3).join(' | ')}`,
            )
          case 'no-browser':
            return signal.reason
          case 'inconclusive':
            return redactText(signal.reason)
        }
      }
      const detail = detailOf()
      if (signal.kind === 'fail') {
        await log(`client probe failed: ${detail}`)
      }
      const status =
        signal.kind === 'ready' ||
        (signal.kind === 'inconclusive' && signal.reason.startsWith('核心界面检查通过'))
          ? 'pass'
          : signal.kind === 'fail'
            ? 'fail'
            : 'inconclusive'
      emit({
        check: 'browser-boot',
        label: '浏览器兼容性检查：加载器与核心界面稳定窗口',
        required: true,
        startedAt: clientStartedAt,
        finishedAt,
        status,
        detail,
      })
      // One browser result is one check. Candidate business behavior is never
      // inferred from the existence of the core shell.
      emit({
        check: 'plugin-function',
        label: '插件业务功能未自动测试',
        required: false,
        startedAt: clientStartedAt,
        finishedAt,
        status: 'skip',
        detail:
          '本次检查安装、配置组合、宿主启动及核心界面；不调用模型、不推断外部服务和插件全部功能正常。',
      })
      const unresolved = clientOutcome.observations?.filter((o) => o.impact === 'review') ?? []
      if (unresolved.length > 0)
        emit({
          check: 'client-observations',
          label: '运行异常的功能影响待确认',
          required: true,
          startedAt: clientStartedAt,
          finishedAt,
          status: 'inconclusive',
          detail: unresolved
            .map((o) => `${o.id} [${o.source}] ${o.address ?? ''} ${o.message}`)
            .join('\n'),
        })
      await writeFileAtomic(
        join(logDir, 'browser-observations.json'),
        JSON.stringify({
          policyVersion: 2,
          observations: clientOutcome.observations ?? [],
          coverage: 'compatibility-only',
        }),
      )
      if (clientOutcome.events.length > 0) {
        const sample = clientOutcome.events.slice(0, 12).join(String.fromCharCode(10))
        await log(`client events:` + String.fromCharCode(10) + sample)
      }
      if (input.acceptClientInconclusive && status === 'inconclusive') {
        await log(
          '--accept-inconclusive no longer bypasses missing browser evidence; complete verification first',
        )
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
  const clientProbeEntries = probes.filter((entry) =>
    ['browser-boot', 'core-contract', 'candidate-contract', 'client-observations'].includes(
      entry.check,
    ),
  )
  const clientReady: ClientReadyState | undefined =
    clientProbeEntries.length === 0
      ? undefined
      : clientProbeEntries.some((entry) => entry.status === 'fail')
        ? 'fail'
        : clientProbeEntries.some((entry) => entry.status === 'skip')
          ? 'skipped'
          : clientProbeEntries.some((entry) => entry.status === 'inconclusive')
            ? 'inconclusive'
            : 'pass'
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
    const candidateReceipt = (
      await analyzeProfile({
        home: labHomeDir(ctx.home, labId),
        profileName: ctx.profileName,
        adapter: adapterDsh01x,
      })
    ).receipt.tree
    const probeJson = `${JSON.stringify({ policyVersion: 2, candidateReceipt, sourceReceipt: manifest.source.receipt, hostVersion: host.raw, labId, finishedAt, summary, probes }, null, 2)}\n`
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
    ...(clientReady !== undefined ? { clientReady } : {}),
  }
  return outcome
}
