import { verificationState } from '../domain/probe.js'
import { withOperations } from '../fs/operation.js'
import { snapshotsDir } from '../fs/paths.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { readArtifact } from '../lab/artifacts.js'
import { closeProbeResultWindows } from '../lab/browser.js'
import { upgradeTick } from '../workflows/upgrades.js'
import { jobEvents } from './job-events.js'
import { openJobStream } from './job-stream.js'
import { mapLimited, ReadCache, watchWorldLine } from './read-cache.js'
import { revisionResponse } from './revisions.js'

const reads = new ReadCache()

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runDoctor } from '../commands/doctor.js'
import {
  runLabAdd,
  runLabDestroy,
  runLabInspect,
  runLabPromoteCommand,
  runLabRemove,
  runLabUpdate,
  runLabVerify,
} from '../commands/lab.js'
import { runLabStart, runLabStop } from '../commands/lab-service.js'
import { runReport } from '../commands/report.js'
import {
  runRescueEnter,
  runRescueList,
  runRescuePlugins,
  runRescueStart,
  runRescueStop,
} from '../commands/rescue.js'
import { runRestoreCommand } from '../commands/restore.js'
import { runSnapshotCreate, validateLabel } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import type { WorldEvent } from '../domain/insight-types.js'
import { redactText } from '../domain/redaction.js'
import { loadDshEnvironment, loadExperimentEnvironment } from '../environment.js'
import { acquireLock } from '../fs/lock.js'
import { resolveLabId, runLabAlias } from '../lab/aliases.js'
import { defaultLabId, runLabDefault } from '../lab/defaults.js'
import { journalPath, type PromotionJournalEntry } from '../lab/journal.js'
import { labHomeDir, labRoot, listLabs } from '../lab/layout.js'
import { currentLabId, managerHome } from '../lab/manager.js'
import { readLabManifest } from '../lab/manifest.js'
import { classifyClientGate } from '../lab/promote.js'
import { readService, serviceStatus } from '../lab/service.js'
import { sourceContext } from '../lab/source.js'
import { lastKnownGoodFor } from '../vault/state.js'
import { actionDefinitions, validateAction } from './action-schema.js'
import { extendedAction, reportContext } from './extended-actions.js'
import { idempotent } from './idempotency.js'
import { compareWorlds, lineContext, snapshotDetail, snapshotEvents } from './insights.js'
import { getJob, listJobs, startJob, subscribeJobs } from './jobs.js'
import { commitMerge, mergePreview, prepareMerge } from './merge.js'

export const name = '@seaveyon/dsh-world-line'
export const inject = ['webServer', 'connection']
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
export interface WebContext {
  get<T>(name: string): T | undefined
  effect(fn: () => () => void, label?: string): void
}

export async function labStatus(ctx: CliContext, id: string) {
  const { manifest, probes } = await reads.read(
    `${ctx.home}:${id}:inspect`,
    [join(labRoot(ctx.home), id, 'manifest.json'), join(labRoot(ctx.home), id, 'probe.json')],
    () => runLabInspect(ctx, id),
  )
  if (manifest.source.profileName !== ctx.profileName)
    throw new UsageError('实验不属于当前 profile')
  const clientGate = classifyClientGate(probes)
  return {
    id,
    name:
      manifest.alias ??
      `验证 ${manifest.plan.find((step) => step.id)?.id ?? '配置'} · ${id.slice(-8)}`,
    profileName: manifest.source.profileName,
    baselineSnapshotId: manifest.source.baselineSnapshotId,
    sourceId: manifest.source.parentLabId ?? 'origin',
    sourceName: manifest.source.parentLabId
      ? ((await readLabManifest(ctx.home, manifest.source.parentLabId).catch(() => null))?.alias ??
        manifest.source.parentLabId)
      : `main · ${manifest.source.profileName}`,
    state: manifest.state,
    verification: verificationState(probes),
    clientGate,
    canPromote:
      !manifest.hostExperiment &&
      manifest.purpose !== 'mirror' &&
      manifest.state === 'passed' &&
      clientGate === 'pass',
    createdAt: manifest.createdAt,
    retained: true,
  }
}

export async function worldLines(ctx: CliContext, currentId?: string) {
  const lines: {
    id: string
    alias?: string
    initialization?: 'clean'
    completedAt?: string
    parentId?: string
    snapshotId?: string
    createdAt: string
    kind: string
    state: string
    verdict: string | null
    port?: number
    isDefault: boolean
  }[] = []
  const completed = new Map<string, string>()
  const journal = await readFile(journalPath(ctx.home), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  for (const row of journal.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(row) as PromotionJournalEntry
      if (entry.profileName === ctx.profileName && entry.labId && entry.outcome === 'committed')
        completed.set(entry.labId, entry.createdAt)
    } catch {
      /* A damaged journal row cannot classify an experiment as complete. */
    }
  }
  const events: WorldEvent[] = [
    ...(await reads.read(`${ctx.home}:${ctx.profileName}:snapshots`, [snapshotsDir(ctx.home)], () =>
      snapshotEvents(ctx, 'origin'),
    )),
  ]
  const eventWarnings: string[] = []
  const defaultId = await defaultLabId(ctx.home, ctx.profileName)
  await mapLimited(await listLabs(ctx.home), 6, async (id) => {
    try {
      const manifest = await reads.read(
        `${ctx.home}:${id}:manifest`,
        [join(labRoot(ctx.home), id, 'manifest.json')],
        () => readLabManifest(ctx.home, id),
      )
      if (manifest.source.profileName !== ctx.profileName) return
      const status = manifest.purpose === 'mirror' ? null : await labStatus(ctx, id)
      events.push({
        id: `${id}:created`,
        lineId: id,
        at: manifest.createdAt,
        kind: 'created',
        title: manifest.source.snapshotId
          ? '从快照分支'
          : manifest.source.parentLabId
            ? '创建旁路分支'
            : '创建世界线',
        detail: manifest.source.snapshotId
          ? `配置来源 ${manifest.source.snapshotId}`
          : '独立实例从这里开始',
      })
      if (manifest.lastRun && Number.isFinite(Date.parse(manifest.lastRun.finishedAt)))
        events.push({
          id: `${id}:verification:${manifest.lastRun.finishedAt}`,
          lineId: id,
          at: manifest.lastRun.finishedAt,
          kind: 'verification',
          title: manifest.lastRun.ok
            ? status && !status.canPromote
              ? '基础检查完成，待浏览器验证'
              : '验证通过'
            : status?.verification === 'review'
              ? '运行异常待确认'
              : status?.verification === 'awaiting_auth'
                ? '等待登录'
                : status?.verification === 'incomplete'
                  ? '验证未完成'
                  : '验证失败',
          detail: manifest.plan.map((step) => step.action).join(' · ') || '启动与功能验证',
        })
      try {
        events.push(
          ...(await reads.read(
            `${ctx.home}:${id}:${ctx.profileName}:snapshots`,
            [snapshotsDir(labHomeDir(ctx.home, id))],
            () => snapshotEvents({ ...ctx, home: labHomeDir(ctx.home, id) }, id),
          )),
        )
      } catch {
        eventWarnings.push(`${manifest.alias ?? id} 的快照暂时无法读取`)
      }
      const service = await reads.read(
        `${ctx.home}:${id}:service`,
        [join(labRoot(ctx.home), id, 'service.json')],
        () => readService(ctx.home, id),
      )
      const reachable =
        service?.state === 'running'
          ? await reads.read(
              `${ctx.home}:${id}:health`,
              [join(labRoot(ctx.home), id, 'service.json')],
              () => serviceStatus(service).catch(() => null),
              30000,
            )
          : null
      lines.push({
        id,
        alias: manifest.alias ?? status?.name,
        completedAt:
          completed.get(id) &&
          completed.get(id)! >= (manifest.lastRun?.finishedAt ?? manifest.createdAt)
            ? completed.get(id)
            : undefined,
        parentId: manifest.source.parentLabId,
        snapshotId: manifest.source.snapshotId,
        initialization: manifest.source.initialization,
        createdAt: manifest.createdAt,
        kind: manifest.purpose === 'mirror' ? 'mirror' : 'verification',
        state:
          service?.state === 'running'
            ? reachable
              ? 'running'
              : 'unreachable'
            : (service?.state ??
              (status && manifest.state === 'passed' && !status.canPromote
                ? 'incomplete'
                : (status?.verification ?? manifest.state))),
        verdict: manifest.lastRun
          ? manifest.lastRun.ok
            ? status && !status.canPromote
              ? 'incomplete'
              : 'passed'
            : (status?.verification ?? 'failed')
          : null,
        port: service?.port,
        isDefault: defaultId === id,
      })
    } catch {
      eventWarnings.push(`${id} 暂时无法读取，请诊断`)
    }
  })
  const { rescues } = await runRescueList(ctx)
  for (const rescue of rescues.filter((item) => item.profileName === ctx.profileName)) {
    const stamp = /^rescue-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(rescue.id)!
    lines.push({
      id: rescue.id,
      alias: `救援 ${rescue.id.slice(-8)}`,
      parentId: undefined,
      snapshotId: undefined,
      createdAt: `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z`,
      kind: 'rescue',
      state: rescue.alive ? 'running' : 'unreachable',
      verdict: null,
      port: rescue.port ?? undefined,
      isDefault: false,
    })
  }
  return {
    lines: lines
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((line) => ({
        ...line,
        forkedAt: line.snapshotId
          ? events.find(
              (event) =>
                event.lineId === (line.parentId ?? 'origin') &&
                event.snapshotId === line.snapshotId,
            )?.at
          : undefined,
      })),
    events: events.toSorted((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    eventWarnings: eventWarnings.sort(),
    capabilities: { merge: true },
    profile: ctx.profileName,
    currentId: currentId ?? null,
    lastKnownGood: await lastKnownGoodFor(ctx.home, ctx.profileName),
    now: new Date().toISOString(),
  }
}

/** Command runners `operate` dispatches to (tests inject fakes per key). */
export interface OperateDeps {
  labUpdate?: typeof runLabUpdate
  labRemove?: typeof runLabRemove
  labAdd?: typeof runLabAdd
  labVerify?: typeof runLabVerify
  promote?: typeof runLabPromoteCommand
  restore?: typeof runRestoreCommand
  doctor?: typeof runDoctor
  report?: typeof runReport
  rescueList?: typeof runRescueList
  rescueStart?: typeof runRescueStart
  rescueStop?: typeof runRescueStop
}

/** Optional boolean flag from a request body; anything else is a usage error. */
function optionalFlag(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new UsageError(`无效选项 ${key}`)
  return value
}

export async function operate(
  ctx: CliContext,
  body: Record<string, unknown>,
  currentId?: string,
  deps: OperateDeps = {},
) {
  const action = validateAction(body)
  return actionDefinitions[action]!.write
    ? idempotent(ctx, body, () => dispatchAction(ctx, body, currentId, deps))
    : dispatchAction(ctx, body, currentId, deps)
}
async function dispatchAction(
  ctx: CliContext,
  body: Record<string, unknown>,
  currentId: string | undefined,
  deps: OperateDeps,
) {
  const action = body.action as string
  const extended = await extendedAction(ctx, body)
  if (extended.handled) return extended.result
  const handlers: Record<string, () => Promise<unknown>> = {}
  const mergePreviewAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择世界线或候选')
    if (action === 'merge-preview') return mergePreview(ctx, body.id)
    if (action === 'merge-commit') return commitMerge(ctx, body.id)
    if (
      typeof body.revision !== 'string' ||
      !Array.isArray(body.plugins) ||
      !body.plugins.every((name) => typeof name === 'string') ||
      typeof body.includeConfig !== 'boolean'
    )
      throw new UsageError('合入选项无效')
    return prepareMerge(ctx, {
      id: body.id,
      revision: body.revision,
      plugins: body.plugins,
      includeConfig: body.includeConfig,
    })
  }
  handlers['merge-preview'] = mergePreviewAction
  handlers['merge-prepare'] = mergePreviewAction
  handlers['merge-commit'] = mergePreviewAction
  const compareAction = async () => {
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      throw new UsageError('请选择两条世界线')
    return compareWorlds(ctx, body.from, body.to)
  }
  handlers['compare'] = compareAction
  const snapshotAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择世界线')
    if (action === 'snapshot-detail') {
      if (typeof body.snapshotId !== 'string') throw new UsageError('请选择快照')
      return snapshotDetail(await lineContext(ctx, body.id), body.snapshotId)
    }
    if (typeof body.label !== 'string' || !body.label.trim()) throw new UsageError('请输入快照名称')
    validateLabel(body.label)
    const lock = await acquireLock({
      lockPath: join(labRoot(ctx.home), '.service.lock'),
      purpose: 'save world-line snapshot',
      breakStale: ctx.breakStaleLock,
    })
    try {
      const selected = await lineContext(ctx, body.id)
      const result = await runSnapshotCreate(selected, { label: body.label.trim() })
      return { snapshotId: result.id, warnings: result.warnings }
    } finally {
      await lock.release()
    }
  }
  handlers['snapshot'] = snapshotAction
  handlers['snapshot-detail'] = snapshotAction
  const createAction = async () => {
    if (typeof body.alias !== 'string' || !body.alias)
      throw new UsageError('请为世界线设置唯一别名')
    if (body.from !== undefined && typeof body.from !== 'string') throw new UsageError('无效的来源')
    if (typeof body.from === 'string') {
      const source = await readLabManifest(ctx.home, await resolveLabId(ctx.home, body.from))
      if (source.source.profileName !== ctx.profileName)
        throw new UsageError('世界线不属于当前 profile')
    }
    if (body.snapshotId !== undefined && typeof body.snapshotId !== 'string')
      throw new UsageError('无效快照')
    return runLabStart(ctx, {
      new: true,
      clean: body.clean === true,
      plugins: body.plugins as string[] | undefined,
      copyPluginConfig: body.copyPluginConfig === true,
      alias: body.alias,
      from: body.from as string | undefined,
      snapshotId: body.snapshotId as string | undefined,
    })
  }
  handlers['create'] = createAction
  const labAddAction = async () => {
    if (typeof body.spec !== 'string' || body.spec.trim() === '')
      throw new UsageError('请输入要验证的插件（包名[@版本] 或本地路径）')
    const spec = body.spec
    if (
      action === 'lab-remove' &&
      (
        adapterDsh01x.profile.templates[ctx.profileName]?.bundles ??
        adapterDsh01x.profile.defaultBundles
      ).includes(spec.trim())
    )
      throw new UsageError('核心运行层不能从 Web 卸载；请使用独立实验验证非核心插件变更')
    if (body.sourceId !== undefined && typeof body.sourceId !== 'string')
      throw new UsageError('无效来源世界线')
    const sourceId =
      !body.sourceId || body.sourceId === 'origin'
        ? 'origin'
        : await resolveLabId(ctx.home, body.sourceId as string)
    await sourceContext(ctx, sourceId)
    const options = {
      sourceId,
      keep: optionalFlag(body, 'keep') ?? true,
      clientProbes: true,
      captureBaseline: true,
      interactive: optionalFlag(body, 'interactive'),
      allowScripts: optionalFlag(body, 'allowScripts'),
      promote: optionalFlag(body, 'promote'),
      acceptInconclusive: optionalFlag(body, 'acceptInconclusive'),
      restart: optionalFlag(body, 'restart'),
    }
    const runner =
      action === 'lab-update'
        ? (deps.labUpdate ?? runLabUpdate)
        : action === 'lab-remove'
          ? (deps.labRemove ?? runLabRemove)
          : (deps.labAdd ?? runLabAdd)
    const job = startJob(
      action as 'lab-add' | 'lab-update' | 'lab-remove',
      (handle) =>
        runner(ctx, spec, {
          ...options,
          onProbe: (probe) => handle.pushProbe(probe),
          onPhase: (phase) => handle.setPhase(phase),
          onLabCreated: (id) => handle.setLabId(id),
          onTransaction: (id) => handle.setTransactionId(id),
        }),
      undefined,
      { home: ctx.home, profileName: ctx.profileName, resource: sourceId },
    )
    return { jobId: job.id }
  }
  handlers['lab-add'] = labAddAction
  handlers['lab-update'] = labAddAction
  handlers['lab-remove'] = labAddAction
  const jobsAction = async () => {
    const records = listJobs(ctx)
    const index = body.before ? records.findIndex((j) => j.id === body.before) : -1
    return records.slice(index + 1, index + 201)
  }
  handlers['jobs'] = jobsAction
  const jobAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择任务')
    const job = getJob(body.id, ctx)
    if (job === undefined) throw new UsageError('任务不存在或已结束，结果以世界线状态为准')
    return job
  }
  handlers['job'] = jobAction
  const restoreAction = async () => {
    if (body.snapshotId !== undefined && typeof body.snapshotId !== 'string')
      throw new UsageError('无效快照')
    if (body.lastKnownGood !== undefined && typeof body.lastKnownGood !== 'boolean')
      throw new UsageError('无效选项 lastKnownGood')
    if (typeof body.snapshotId === 'string' && body.lastKnownGood === true)
      throw new UsageError('指定快照与回滚到稳定世界线只能二选一')
    if (typeof body.snapshotId !== 'string' && body.lastKnownGood !== true)
      throw new UsageError('请选择要恢复的快照')
    const options = {
      ...(typeof body.snapshotId === 'string' ? { snapshotId: body.snapshotId } : {}),
      ...(body.lastKnownGood === true ? { lastKnownGood: true } : {}),
      promote: optionalFlag(body, 'promote'),
      restart: optionalFlag(body, 'restart'),
      keep: optionalFlag(body, 'keep'),
      acceptInconclusive: optionalFlag(body, 'acceptInconclusive'),
    }
    const job = startJob(
      'restore',
      (handle) =>
        (deps.restore ?? runRestoreCommand)(ctx, {
          ...options,
          onProbe: (probe) => handle.pushProbe(probe),
          onPhase: (phase) => handle.setPhase(phase),
          onLabCreated: (id) => handle.setLabId(id),
          onTransaction: (id) => handle.setTransactionId(id),
        }),
      undefined,
      { home: ctx.home, profileName: ctx.profileName, resource: 'origin' },
    )
    return { jobId: job.id }
  }
  handlers['restore'] = restoreAction
  const doctorAction = async () => {
    return (deps.doctor ?? runDoctor)(ctx)
  }
  handlers['doctor'] = doctorAction
  const reportAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择世界线或快照')
    const reportCtx = await reportContext(ctx, body.id, body.lineId as string | undefined)
    return (deps.report ?? runReport)(reportCtx, body.id)
  }
  handlers['report'] = reportAction
  const rescueEnterAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择救援实例')
    return runRescueEnter(ctx, body.id)
  }
  handlers['rescue-enter'] = rescueEnterAction
  const rescueListAction = async () => {
    return (deps.rescueList ?? runRescueList)(ctx)
  }
  handlers['rescue-list'] = rescueListAction
  handlers['rescue-plugins'] = () => runRescuePlugins(ctx)
  handlers['clean-plugins'] = async () => {
    const target = typeof body.id === 'string' ? await lineContext(ctx, body.id) : ctx
    const result = await runRescuePlugins(target)
    return {
      plugins: result.plugins
        .filter((p) => p.id.startsWith('bundle:'))
        .map((p) => ({ ...p, id: p.id.slice(7) })),
    }
  }
  handlers['rescue-start'] = async () => {
    throw new UsageError('请改用创建世界线中的「从干净环境开始」')
  }
  const rescueStopAction = async () => {
    if (typeof body.id !== 'string') throw new UsageError('请选择救援实例')
    return (deps.rescueStop ?? runRescueStop)(ctx, body.id)
  }
  handlers['rescue-stop'] = rescueStopAction
  if (Object.hasOwn(handlers, action)) return handlers[action]!()

  if (typeof body.id !== 'string') throw new UsageError('请选择世界线')
  const id = await resolveLabId(ctx.home, body.id)
  const manifest = await readLabManifest(ctx.home, id)
  if (manifest.source.profileName !== ctx.profileName)
    throw new UsageError('世界线不属于当前 profile')
  const labHandlers: Record<string, () => Promise<unknown>> = {
    'lab-status': async () => {
      return labStatus(ctx, id)
    },
    'lab-verify': async () => {
      const interactive = optionalFlag(body, 'interactive')
      if (manifest.purpose === 'mirror') throw new UsageError('请选择验证实验')
      const job = startJob(
        'lab-verify',
        (handle) =>
          (deps.labVerify ?? runLabVerify)(ctx, id, {
            interactive,
            onProbe: (probe) => handle.pushProbe(probe),
            onPhase: (phase) => handle.setPhase(phase),
          }),
        id,
        {
          home: ctx.home,
          profileName: ctx.profileName,
          resource: manifest.source.parentLabId ?? 'origin',
        },
      )
      return { jobId: job.id }
    },
    promote: async () => {
      const options = {
        acceptReview: optionalFlag(body, 'acceptReview'),
        acceptInconclusive: optionalFlag(body, 'acceptInconclusive'),
        restart: optionalFlag(body, 'restart'),
      }
      const job = startJob(
        'promote',
        (handle) =>
          (deps.promote ?? runLabPromoteCommand)(ctx, id, {
            ...options,
            onPhase: (phase) => handle.setPhase(phase),
            onTransaction: (transactionId) => handle.setTransactionId(transactionId),
          }),
        id,
        {
          home: ctx.home,
          profileName: ctx.profileName,
          resource: manifest.source.parentLabId ?? 'origin',
        },
      )
      return { jobId: job.id }
    },
    restart: async () => {
      if (id === currentId) throw new UsageError('请从另一实例重启当前正在访问的世界线')
      if (manifest.purpose !== 'mirror') throw new UsageError('只有普通世界线可以重启')
      return withOperations(
        [labHomeDir(ctx.home, id)],
        ctx.profileName,
        async () => {
          await runLabStop(ctx, id)
          return runLabStart(ctx, { id })
        },
        ctx.breakStaleLock,
      )
    },
    start: async () => {
      return runLabStart(ctx, { id })
    },
    stop: async () => {
      if (id === currentId) throw new UsageError('请从另一实例管理当前正在访问的世界线')
      return action === 'stop' ? runLabStop(ctx, id) : runLabDestroy(ctx, id)
    },
    destroy: async () => {
      if (id === currentId) throw new UsageError('请从另一实例管理当前正在访问的世界线')
      return action === 'stop' ? runLabStop(ctx, id) : runLabDestroy(ctx, id)
    },
    default: async () => {
      return runLabDefault(ctx, id)
    },
    alias: async () => {
      return runLabAlias(ctx, id, body.alias as string)
    },
  }
  if (Object.hasOwn(labHandlers, action)) return labHandlers[action]!()

  throw new UsageError('未知操作')
}

export function apply(host: WebContext, config: { profile?: string } = {}): void {
  const server = host.get<{
    register(route: { kind: 'exact'; path: string; handler: Handler }): () => void
  }>('webServer')
  const connection = host.get<{ requestRejection(req: IncomingMessage): number | undefined }>(
    'connection',
  )
  if (!server || !connection?.requestRejection)
    throw new Error('World Line requires DSH browser authentication')
  const runtimeHome = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const currentId = currentLabId(runtimeHome, process.env.WORLD_LINE_LAB)
  const home = managerHome(runtimeHome, currentId, process.env.WORLD_LINE_MANAGER_HOME)
  host.effect(() => watchWorldLine(home, reads), 'world-line: metadata invalidation')
  host.effect(
    () => () => {
      void closeProbeResultWindows()
    },
    'world-line: result window ownership',
  )
  const context = async (): Promise<CliContext> => {
    const env = await loadDshEnvironment(home, process.env)
    return {
      home,
      env,
      experimentEnv: await loadExperimentEnvironment(env, process.env),
      cwd: home,
      profileName: config.profile ?? 'web',
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
  }
  host.effect(() => {
    let stopped = false
    const tick = () => {
      if (!stopped)
        void context()
          .then(upgradeTick)
          .catch(() => {})
    }
    const timer = setInterval(tick, 60000)
    tick()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'world-line: upgrade scheduler')
  host.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/world-line',
        handler: async (req, res) => {
          const send = (status: number, data: unknown) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            res.end(JSON.stringify(data))
          }
          const rejection = connection.requestRejection(req)
          if (rejection) {
            send(rejection, { error: '请重新打开 DSH 登录入口' })
            return
          }
          try {
            if (
              req.method === 'GET' &&
              new URL(req.url ?? '/', 'http://localhost').searchParams.get('stream') === 'jobs'
            ) {
              const ctx = await context()
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                'x-accel-buffering': 'no',
              })
              let last =
                typeof req.headers['last-event-id'] === 'string'
                  ? req.headers['last-event-id']
                  : undefined
              openJobStream(
                res,
                () => {
                  const events = jobEvents(ctx, last)
                  if (events.length) last = events.at(-1)!.id
                  return events
                },
                subscribeJobs,
                () => !!connection.requestRejection(req),
              )
              return
            }
            if (
              req.method === 'GET' &&
              new URL(req.url ?? '/', 'http://localhost').searchParams.has('artifact')
            ) {
              const params = new URL(req.url ?? '/', 'http://localhost').searchParams
              const ctx = await context()
              const labId = params.get('lab') ?? ''
              await reportContext(ctx, labId)
              const name = params.get('file') ?? ''
              const bytes = await readArtifact(ctx.home, labId, params.get('artifact') ?? '', name)
              res.writeHead(200, {
                'content-type': name === 'failure.png' ? 'image/png' : 'application/zip',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                'content-disposition': `attachment; filename="${name}"`,
                'referrer-policy': 'no-referrer',
              })
              res.end(bytes)
              return
            }
            if (req.method === 'GET') {
              const ctx = await context()
              const result = await reads.read(
                `${ctx.home}:${ctx.profileName}:${currentId}:world-lines`,
                [labRoot(ctx.home), journalPath(ctx.home), snapshotsDir(ctx.home)],
                () => worldLines(ctx, currentId),
                1500,
              )
              const since = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')
              send(
                200,
                revisionResponse(`${ctx.home}:${ctx.profileName}:${currentId}`, result, since),
              )
              return
            }
            if (req.method !== 'POST') {
              send(405, { error: 'Method not allowed' })
              return
            }
            // Require an explicit same-origin JSON request in addition to native authentication.
            if (
              !req.headers.origin ||
              new URL(req.headers.origin).host !== req.headers.host ||
              req.headers['content-type'] !== 'application/json'
            ) {
              send(403, { error: 'Same-origin JSON request required' })
              return
            }
            const chunks: Buffer[] = []
            let length = 0
            for await (const chunk of req) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              length += bytes.length
              if (length > 34 * 1024 * 1024) {
                send(413, { error: 'Request too large' })
                return
              }
              chunks.push(bytes)
            }
            const raw = Buffer.concat(chunks, length).toString('utf8')
            let body: unknown
            try {
              body = JSON.parse(raw)
            } catch (error) {
              if (Buffer.byteLength(raw) > 8192) {
                send(413, { error: 'Request too large' })
                return
              }
              throw error
            }
            if (
              Buffer.byteLength(raw) > 8192 &&
              !['lab-config-apply', 'environment-import'].includes(
                (body as { action?: string })?.action ?? '',
              )
            ) {
              send(413, { error: 'Request too large' })
              return
            }
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new UsageError('无效请求')
            send(
              200,
              await operate(
                { ...(await context()), authenticatedWebAction: true },
                body as Record<string, unknown>,
                currentId,
              ),
            )
          } catch (error) {
            send(error instanceof UsageError ? 400 : 500, {
              error: redactText(error instanceof Error ? error.message : '操作失败'),
            })
          }
        },
      }),
    'world-line: authenticated management API',
  )
}
