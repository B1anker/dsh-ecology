/**
 * The management API the browser bundle (`./client`) calls, as a service.
 *
 * Every route runs Git against a caller-supplied path, so the service takes
 * the host's `connection` alongside the registry and registers only through
 * the fenced view of it (`fenceRoutes`). The container guarantees the pairing:
 * a `WorktreeApi` cannot be built without both.
 *
 * @module @seaveyon/dsh-git-worktree/api
 */

import { createDecorator, inject } from '@seaveyon/dsh-di'
import {
  classifyWorkspacePaths,
  createDetachedWorktreeFromLatest,
  createWorktreeFromLatest,
  inspectWorktreeConflict,
  listBranches,
  removeWorktree,
} from './git.js'
import { IConnection, IWebServer } from './host-services.js'
import { fileManagerKind, revealInFileManager } from './reveal.js'
import {
  type ConnectionService,
  fenceRoutes,
  type RouteHandler,
  readJsonBody,
  sendJson,
  type WebServerService,
  withHandlerTimeout,
} from './web.js'

/** One management route: where it mounts, what to call its registration, what it does. */
export interface ManagementRoute {
  readonly path: string
  readonly label: string
  readonly handler: RouteHandler
}

export interface IWorktreeApi {
  readonly _serviceBrand: undefined
  /** The routes, unfenced, in registration order. For inspection. */
  readonly routes: readonly ManagementRoute[]
  /** Register one route behind the fence; returns its disposer. */
  register(route: ManagementRoute): () => void
}

export const IWorktreeApi = createDecorator<IWorktreeApi>('worktreeApi')

const PREFIX = '/api/plugins/dsh-git-worktree'

function failure(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) }
}

@inject(IWebServer, IConnection)
export class WorktreeApi implements IWorktreeApi {
  declare readonly _serviceBrand: undefined
  private readonly fenced: WebServerService
  readonly routes: readonly ManagementRoute[]

  constructor(registry: WebServerService, connection: ConnectionService) {
    this.fenced = fenceRoutes(registry, connection)
    this.routes = [
      { path: `${PREFIX}/branches`, label: 'branches endpoint', handler: branches },
      {
        path: `${PREFIX}/create-conflict`,
        label: 'create conflict endpoint',
        handler: createConflict,
      },
      { path: `${PREFIX}/create`, label: 'create endpoint', handler: create },
      { path: `${PREFIX}/remove`, label: 'remove endpoint', handler: remove },
      {
        path: `${PREFIX}/workspace-groups`,
        label: 'workspace groups endpoint',
        handler: workspaceGroups,
      },
      { path: `${PREFIX}/reveal`, label: 'reveal endpoint', handler: reveal },
    ]
  }

  register(route: ManagementRoute): () => void {
    return this.fenced.register({ kind: 'exact', path: route.path, handler: route.handler })
  }
}

const branches: RouteHandler = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  const body = await readJsonBody(req)
  if (typeof body.cwd !== 'string') return sendJson(res, 400, { error: 'cwd_required' })
  try {
    sendJson(res, 200, await listBranches(body.cwd))
  } catch (error) {
    sendJson(res, 400, failure(error))
  }
}

const createConflict: RouteHandler = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  const body = await readJsonBody(req)
  if (typeof body.cwd !== 'string' || typeof body.branch !== 'string')
    return sendJson(res, 400, { error: 'cwd_and_branch_required' })
  try {
    sendJson(res, 200, await inspectWorktreeConflict({ cwd: body.cwd, branch: body.branch }))
  } catch (error) {
    sendJson(res, 400, failure(error))
  }
}

const create: RouteHandler = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  const body = await readJsonBody(req)
  if (
    typeof body.cwd !== 'string' ||
    typeof body.baseRef !== 'string' ||
    (body.branch !== undefined && typeof body.branch !== 'string') ||
    (body.overwrite !== undefined && typeof body.overwrite !== 'boolean')
  )
    return sendJson(res, 400, { error: 'cwd_and_base_ref_required' })
  try {
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    sendJson(
      res,
      201,
      branch.length > 0
        ? await createWorktreeFromLatest({
            cwd: body.cwd,
            baseRef: body.baseRef,
            branch,
            overwrite: body.overwrite === true,
          })
        : await createDetachedWorktreeFromLatest(body.cwd, body.baseRef),
    )
  } catch (error) {
    sendJson(res, 400, failure(error))
  }
}

const remove: RouteHandler = async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  const body = await readJsonBody(req)
  if (typeof body.cwd !== 'string') return sendJson(res, 400, { error: 'cwd_required' })
  try {
    sendJson(res, 200, await removeWorktree(body.cwd))
  } catch (error) {
    sendJson(res, 400, failure(error))
  }
}

const workspaceGroups: RouteHandler = async (req, res) => {
  await withHandlerTimeout(res, 8_000, async () => {
    let paths: string[] | undefined
    if (req.method === 'GET') {
      const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('paths')
      if (raw === null) return sendJson(res, 400, { error: 'paths_required' })
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string'))
        return sendJson(res, 400, { error: 'paths_required' })
      paths = parsed
    } else if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== 'string'))
        return sendJson(res, 400, { error: 'paths_required' })
      paths = body.paths
    } else {
      return sendJson(res, 405, { error: 'method_not_allowed' })
    }
    sendJson(res, 200, { items: await classifyWorkspacePaths(paths) })
  })
}

const reveal: RouteHandler = async (req, res) => {
  if (req.method === 'GET') {
    sendJson(res, 200, { kind: fileManagerKind() })
    return
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
  const body = await readJsonBody(req)
  if (typeof body.path !== 'string') return sendJson(res, 400, { error: 'path_required' })
  try {
    sendJson(res, 200, await revealInFileManager(body.path))
  } catch (error) {
    sendJson(res, 400, failure(error))
  }
}
