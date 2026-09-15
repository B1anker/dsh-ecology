/**
 * The operations behind the management API: the world-line projection
 * (`worldLines`, `labStatus`) and the action dispatcher (`operate`). Pure
 * functions of a `CliContext`; the route that calls them is ./api and the
 * graph that wires them is ./services.
 *
 * @module @seaveyon/dsh-world-line/web/operations
 */

import { verificationState } from '../domain/probe.js'
import { withOperations } from '../fs/operation.js'
import { snapshotsDir } from '../fs/paths.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { mapLimited, ReadCache } from './read-cache.js'

/**
 * Derived-read cache shared by every function in this module. Registered in
 * the plugin's service graph under `IReadCache` (see ./services) so the API
 * and the invalidation watcher use this same instance.
 */
export const readCache = new ReadCache()
const reads = readCache

function restoreTimelineEvent(entry: PromotionJournalEntry, lineId: string): WorldEvent | null {
  if (entry.kind !== 'restore' || entry.outcome !== 'committed' || !entry.snapshotId) return null
  const unchanged = entry.receiptBefore === entry.receiptAfter
  return {
    id: `${entry.id}:restored`,
    lineId,
    at: entry.createdAt,
    kind: 'restore',
    title: unchanged ? '恢复完成 · 配置未变' : '恢复完成',
    detail: unchanged ? '恢复前就与目标一致，无需改动。' : '已换回所选快照的插件和配置。',
    snapshotId: entry.snapshotId,
    afterSnapshotId: entry.afterSnapshot ?? undefined,
    unchanged,
  }
}

/** Profile-scoped promotion journal entries; a missing journal reads as empty. */
async function readJournalEntries(
  home: string,
  profileName: string,
): Promise<PromotionJournalEntry[]> {
  const journal = await readFile(journalPath(home), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const entries: PromotionJournalEntry[] = []
  for (const row of journal.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(row) as PromotionJournalEntry
      if (entry.profileName === profileName) entries.push(entry)
    } catch {
      /* A damaged journal row can neither complete an experiment nor hide a line's snapshots. */
    }
  }
  return entries
}

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { acquireLock } from '../fs/lock.js'
import { resolveLabId, runLabAlias } from '../lab/aliases.js'
import { defaultLabId, runLabDefault } from '../lab/defaults.js'
import { journalPath, type PromotionJournalEntry } from '../lab/journal.js'
import { labHomeDir, labRoot, listLabs } from '../lab/layout.js'
import type { LabManifest } from '../lab/manifest.js'
import { readLabManifest } from '../lab/manifest.js'
import { classifyClientGate } from '../lab/promote.js'
import { readService, serviceStatus } from '../lab/service.js'
import { sourceContext } from '../lab/source.js'
import { lastKnownGoodFor } from '../vault/state.js'
import { actionDefinitions, validateAction } from './action-schema.js'
import { extendedAction, reportContext } from './extended-actions.js'
import { idempotent } from './idempotency.js'
import {
  assertOwnsLine,
  compareWorlds,
  lineContext,
  snapshotDetail,
  snapshotEvents,
} from './insights.js'
import { getJob, listJobs, startScopedJob } from './jobs.js'
import { commitMerge, mergePreview, prepareMerge } from './merge.js'
import { projectMerges } from './merge-events.js'
import { projectOperations } from './operation-events.js'
import type { WorldLineInfo } from './types.js'

export async function labStatus(ctx: CliContext, id: string) {
  const { manifest, probes } = await reads.read(
    `${ctx.home}:${id}:inspect`,
    [join(labRoot(ctx.home), id, 'manifest.json'), join(labRoot(ctx.home), id, 'probe.json')],
    () => runLabInspect(ctx, id),
  )
  assertOwnsLine(manifest, ctx, '实验不属于当前 profile')
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
  const lines: WorldLineInfo[] = []
  const completed = new Map<string, string>()
  const operationLabs: LabManifest[] = []
  const operationJournal: PromotionJournalEntry[] = []
  const restored = [] as WorldEvent[]
  for (const entry of await readJournalEntries(ctx.home, ctx.profileName)) {
    operationJournal.push(entry)
    if (entry.labId && entry.outcome === 'committed') completed.set(entry.labId, entry.createdAt)
    const event = restoreTimelineEvent(entry, 'origin')
    if (event) restored.push(event)
  }
  const events: WorldEvent[] = [
    ...(await reads.read(`${ctx.home}:${ctx.profileName}:snapshots`, [snapshotsDir(ctx.home)], () =>
      snapshotEvents(ctx, 'origin'),
    )),
    ...restored,
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
      operationLabs.push(manifest)
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
        for (const entry of await readJournalEntries(labHomeDir(ctx.home, id), ctx.profileName)) {
          operationJournal.push(entry)
          const event = restoreTimelineEvent(entry, id)
          if (event) events.push(event)
        }
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
  // Manager journals also contain restores into child lines. Attribute them by
  // the resulting snapshot's owner, even when the temporary restore lab is gone.
  const restoreIds = new Set<string>()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.kind !== 'restore') continue
    const result = events.find(
      (item) => item.kind === 'snapshot' && item.snapshotId === event.afterSnapshotId,
    )
    if (result) {
      event.lineId = result.lineId
      event.at = result.at
    }
    if (restoreIds.has(event.id)) events.splice(index, 1)
    else restoreIds.add(event.id)
  }
  projectOperations(events, operationLabs, operationJournal)
  await projectMerges(ctx, events)
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
    if (body.targetId !== undefined && (typeof body.targetId !== 'string' || !body.targetId))
      throw new UsageError('请选择有效的目标世界线')
    if (action === 'merge-preview') return mergePreview(ctx, body.id, body.targetId)
    if (action === 'merge-commit')
      return commitMerge(ctx, body.id, { acceptReview: body.acceptReview === true })
    if (
      typeof body.revision !== 'string' ||
      !Array.isArray(body.plugins) ||
      !body.plugins.every((name) => typeof name === 'string') ||
      typeof body.includeConfig !== 'boolean'
    )
      throw new UsageError('合入选项无效')
    return prepareMerge(ctx, {
      id: body.id,
      targetId: body.targetId,
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
      assertOwnsLine(source, ctx)
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
    const job = startScopedJob(
      ctx,
      sourceId,
      action as 'lab-add' | 'lab-update' | 'lab-remove',
      (_handle, hooks) => runner(ctx, spec, { ...options, ...hooks }),
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
    if (body.sourceId !== undefined && typeof body.sourceId !== 'string')
      throw new UsageError('无效来源世界线')
    const sourceId =
      !body.sourceId || body.sourceId === 'origin'
        ? 'origin'
        : await resolveLabId(ctx.home, body.sourceId as string)
    const source = await sourceContext(ctx, sourceId)
    const options = {
      ...(typeof body.snapshotId === 'string' ? { snapshotId: body.snapshotId } : {}),
      ...(body.lastKnownGood === true ? { lastKnownGood: true } : {}),
      promote: optionalFlag(body, 'promote'),
      restart: optionalFlag(body, 'restart'),
      keep: optionalFlag(body, 'keep'),
      acceptInconclusive: optionalFlag(body, 'acceptInconclusive'),
      // Keep the recovery lab in the manager home, then promote it back to the
      // selected source line rather than accidentally looking in main's vault.
      manager: ctx,
      ...(sourceId === 'origin' ? {} : { sourceId }),
    }
    const job = startScopedJob(ctx, sourceId, 'restore', (_handle, hooks) =>
      (deps.restore ?? runRestoreCommand)(source, { ...options, ...hooks }),
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
  assertOwnsLine(manifest, ctx)
  const stopOrDestroyAction = async () => {
    if (id === currentId) throw new UsageError('请从另一实例管理当前正在访问的世界线')
    return action === 'stop' ? runLabStop(ctx, id) : runLabDestroy(ctx, id)
  }
  const labHandlers: Record<string, () => Promise<unknown>> = {
    'lab-status': async () => {
      return labStatus(ctx, id)
    },
    'lab-verify': async () => {
      const interactive = optionalFlag(body, 'interactive')
      if (manifest.purpose === 'mirror') throw new UsageError('请选择验证实验')
      const job = startScopedJob(
        ctx,
        manifest.source.parentLabId ?? 'origin',
        'lab-verify',
        (_handle, hooks) =>
          (deps.labVerify ?? runLabVerify)(ctx, id, {
            interactive,
            onProbe: hooks.onProbe,
            onPhase: hooks.onPhase,
          }),
        id,
      )
      return { jobId: job.id }
    },
    promote: async () => {
      const options = {
        acceptReview: optionalFlag(body, 'acceptReview'),
        acceptInconclusive: optionalFlag(body, 'acceptInconclusive'),
        restart: optionalFlag(body, 'restart'),
      }
      const job = startScopedJob(
        ctx,
        manifest.source.parentLabId ?? 'origin',
        'promote',
        (_handle, hooks) =>
          (deps.promote ?? runLabPromoteCommand)(ctx, id, {
            ...options,
            onPhase: hooks.onPhase,
            onTransaction: hooks.onTransaction,
          }),
        id,
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
    stop: stopOrDestroyAction,
    destroy: stopOrDestroyAction,
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
