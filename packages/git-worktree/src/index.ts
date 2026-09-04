import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  classifyWorkspacePaths,
  createDetachedWorktreeFromLatest,
  createWorktree,
  createWorktreeFromLatest,
  inspectWorktreeConflict,
  listBranches,
  listWorktrees,
  removeWorktree,
  resolveSessionCwd,
} from './git.js'
import { readJsonBody, sendJson, type WebServerService } from './web.js'

export {
  assertBranchName,
  createWorktree,
  GitWorktreeError,
  listWorktrees,
  repositoryRoot,
} from './git.js'

export const name = 'dsh-git-worktree'
export const inject = ['tools', 'webServer']

function text(value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

// Tool values must be lossless JSON. The Git domain objects contain only
// strings and booleans, but serializing at this boundary also keeps a future
// internal implementation detail from leaking into a durable tool event.
function json(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Adds server-only tools.  There is deliberately no `dsh.client` entry: this
 * plugin neither replaces Web services nor assumes a particular UI slot.
 */
export function apply(ctx: {
  tools: { register(tool: ReturnType<typeof defineTool>): unknown }
  get<T>(name: string): T | undefined
  effect(fn: () => (() => void) | void, label?: string): void
}) {
  const server = ctx.get<WebServerService>('webServer')
  if (server === undefined) throw new Error('dsh-git-worktree: webServer service missing')
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/plugins/dsh-git-worktree/branches',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
          const body = await readJsonBody(req)
          if (typeof body.cwd !== 'string') return sendJson(res, 400, { error: 'cwd_required' })
          try {
            sendJson(res, 200, await listBranches(body.cwd))
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-git-worktree: branches endpoint',
  )
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/plugins/dsh-git-worktree/create-conflict',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
          const body = await readJsonBody(req)
          if (typeof body.cwd !== 'string' || typeof body.branch !== 'string')
            return sendJson(res, 400, { error: 'cwd_and_branch_required' })
          try {
            sendJson(
              res,
              200,
              await inspectWorktreeConflict({ cwd: body.cwd, branch: body.branch }),
            )
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-git-worktree: create conflict endpoint',
  )
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/plugins/dsh-git-worktree/create',
        handler: async (req, res) => {
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
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-git-worktree: create endpoint',
  )
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/plugins/dsh-git-worktree/remove',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
          const body = await readJsonBody(req)
          if (typeof body.cwd !== 'string') return sendJson(res, 400, { error: 'cwd_required' })
          try {
            sendJson(res, 200, await removeWorktree(body.cwd))
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-git-worktree: remove endpoint',
  )
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: '/api/plugins/dsh-git-worktree/workspace-groups',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
          const body = await readJsonBody(req)
          if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== 'string'))
            return sendJson(res, 400, { error: 'paths_required' })
          try {
            sendJson(res, 200, { items: await classifyWorkspacePaths(body.paths) })
          } catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'dsh-git-worktree: workspace groups endpoint',
  )
  ctx.tools.register(
    defineTool({
      name: 'worktree_list',
      description:
        'List Git worktrees for the repository containing the current DSH session workspace.',
      parameters: {},
      output: {
        schema: { type: 'json' } as const,
        render: (_args, value) => text(value),
      },
      async execute(_args, execution) {
        return json(
          await listWorktrees(
            resolveSessionCwd(execution.agent?.session.header.cwd),
            execution.signal,
          ),
        )
      },
      presentCall: () => ({ card: 'generic', title: 'List Git worktrees', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'worktree_create',
      description:
        'Create a new Git worktree on a new branch. The repository is inferred from the current DSH session workspace. This never reuses or overwrites an existing directory.',
      parameters: {
        branch: {
          type: 'string',
          required: true,
          description: 'New Git branch name, for example feat/add-login.',
        },
        base_ref: {
          type: 'string',
          description: 'Existing commit, branch, or tag to start from. Defaults to HEAD.',
        },
      } as const,
      output: {
        schema: { type: 'json' } as const,
        render: (_args, value) => text(value),
      },
      async execute(args, execution) {
        return json(
          await createWorktree(
            {
              cwd: resolveSessionCwd(execution.agent?.session.header.cwd),
              branch: args.branch,
              baseRef: args.base_ref,
            },
            execution.signal,
          ),
        )
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Create worktree: ${args.branch}`,
        kind: 'execute',
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'worktree_remove',
      description:
        'Remove the current linked Git worktree, physically delete its directory, and delete its local branch. The primary repository checkout is protected.',
      parameters: {},
      output: {
        schema: { type: 'json' } as const,
        render: (_args, value) => text(value),
      },
      async execute(_args, execution) {
        return json(
          await removeWorktree(
            resolveSessionCwd(execution.agent?.session.header.cwd),
            execution.signal,
          ),
        )
      },
      presentCall: () => ({ card: 'generic', title: 'Remove Git worktree', kind: 'execute' }),
    }),
  )
}
