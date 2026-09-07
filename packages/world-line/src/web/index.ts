import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runLabDestroy } from '../commands/lab.js'
import { runLabStart, runLabStop } from '../commands/lab-service.js'
import { runSnapshotCreate, validateLabel } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import type { WorldEvent } from '../domain/insight-types.js'
import { redactText } from '../domain/redaction.js'
import { loadDshEnvironment, loadExperimentEnvironment } from '../environment.js'
import { acquireLock } from '../fs/lock.js'
import { resolveLabId, runLabAlias } from '../lab/aliases.js'
import { defaultLabId, runLabDefault } from '../lab/defaults.js'
import { labHomeDir, labRoot, listLabs } from '../lab/layout.js'
import { currentLabId, managerHome } from '../lab/manager.js'
import { readLabManifest } from '../lab/manifest.js'
import { readService, serviceStatus } from '../lab/service.js'
import { compareWorlds, lineContext, snapshotDetail, snapshotEvents } from './insights.js'
import { commitMerge, mergePreview, prepareMerge } from './merge.js'

export const name = '@seaveyon/dsh-world-line'
export const inject = ['webServer', 'connection']
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
export interface WebContext {
  get<T>(name: string): T | undefined
  effect(fn: () => () => void, label?: string): void
}

export async function worldLines(ctx: CliContext, currentId?: string) {
  const lines = []
  const events: WorldEvent[] = await snapshotEvents(ctx, 'origin')
  const eventWarnings: string[] = []
  for (const id of await listLabs(ctx.home)) {
    const manifest = await readLabManifest(ctx.home, id)
    if (manifest.source.profileName !== ctx.profileName) continue
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
    if (manifest.lastRun)
      events.push({
        id: `${id}:verification:${manifest.lastRun.finishedAt}`,
        lineId: id,
        at: manifest.lastRun.finishedAt,
        kind: 'verification',
        title: manifest.lastRun.ok ? '验证通过' : '验证失败',
        detail: manifest.plan.map((step) => step.action).join(' · ') || '启动与功能验证',
      })
    try {
      events.push(...(await snapshotEvents({ ...ctx, home: labHomeDir(ctx.home, id) }, id)))
    } catch {
      eventWarnings.push(`${manifest.alias ?? id} 的快照暂时无法读取`)
    }
    const service = await readService(ctx.home, id)
    const reachable =
      service?.state === 'running' ? await serviceStatus(service).catch(() => null) : null
    lines.push({
      id,
      alias: manifest.alias,
      parentId: manifest.source.parentLabId,
      snapshotId: manifest.source.snapshotId,
      createdAt: manifest.createdAt,
      kind: manifest.purpose === 'mirror' ? 'mirror' : 'verification',
      state:
        service?.state === 'running'
          ? reachable
            ? 'running'
            : 'unreachable'
          : (service?.state ?? manifest.state),
      verdict: manifest.lastRun ? (manifest.lastRun.ok ? 'passed' : 'failed') : null,
      port: service?.port,
      isDefault: (await defaultLabId(ctx.home, ctx.profileName)) === id,
    })
  }
  return {
    lines: lines.map((line) => ({
      ...line,
      forkedAt: line.snapshotId
        ? events.find(
            (event) =>
              event.lineId === (line.parentId ?? 'origin') && event.snapshotId === line.snapshotId,
          )?.at
        : undefined,
    })),
    events: events.toSorted((a, b) => a.at.localeCompare(b.at)),
    eventWarnings,
    capabilities: { merge: true },
    profile: ctx.profileName,
    currentId: currentId ?? null,
    now: new Date().toISOString(),
  }
}

export async function operate(ctx: CliContext, body: Record<string, unknown>, currentId?: string) {
  const action = body.action
  if (action === 'merge-preview' || action === 'merge-prepare' || action === 'merge-commit') {
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
  if (action === 'compare') {
    if (typeof body.from !== 'string' || typeof body.to !== 'string')
      throw new UsageError('请选择两条世界线')
    return compareWorlds(ctx, body.from, body.to)
  }
  if (action === 'snapshot' || action === 'snapshot-detail') {
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
  if (action === 'create') {
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
      alias: body.alias,
      from: body.from as string | undefined,
      snapshotId: body.snapshotId as string | undefined,
    })
  }
  if (typeof body.id !== 'string') throw new UsageError('请选择世界线')
  const id = await resolveLabId(ctx.home, body.id)
  const manifest = await readLabManifest(ctx.home, id)
  if (manifest.source.profileName !== ctx.profileName)
    throw new UsageError('世界线不属于当前 profile')
  if (action === 'start') return runLabStart(ctx, { id })
  if (action === 'stop' || action === 'destroy') {
    if (id === currentId) throw new UsageError('请从另一实例管理当前正在访问的世界线')
    return action === 'stop' ? runLabStop(ctx, id) : runLabDestroy(ctx, id)
  }
  if (action === 'default') return runLabDefault(ctx, id)
  if (action === 'alias' && typeof body.alias === 'string') return runLabAlias(ctx, id, body.alias)
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
            if (req.method === 'GET') {
              send(200, await worldLines(await context(), currentId))
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
            let raw = ''
            for await (const chunk of req) {
              raw += chunk
              if (Buffer.byteLength(raw) > 8192) {
                send(413, { error: 'Request too large' })
                return
              }
            }
            const body: unknown = JSON.parse(raw)
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new UsageError('无效请求')
            send(200, await operate(await context(), body as Record<string, unknown>, currentId))
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
