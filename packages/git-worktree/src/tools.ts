/**
 * The three agent tools, as a service over the host's `tools` registry.
 *
 * The tools run against the session's own workspace (`execution.agent`'s
 * session cwd), which is why they need no fence: the path never comes from a
 * caller. Contrast `api.ts`.
 *
 * @module @seaveyon/dsh-git-worktree/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDecorator, inject } from '@seaveyon/dsh-di'
import { createWorktree, listWorktrees, removeWorktree, resolveSessionCwd } from './git.js'
import { ITools, type ToolsService } from './host-services.js'

export interface IWorktreeTools {
  readonly _serviceBrand: undefined
  /** The tool names, in registration order. For inspection. */
  readonly names: readonly string[]
  /** Register every tool with the host. */
  register(): void
}

export const IWorktreeTools = createDecorator<IWorktreeTools>('worktreeTools')

function text(value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

// Tool values must be lossless JSON. The Git domain objects contain only
// strings and booleans, but serializing at this boundary also keeps a future
// internal implementation detail from leaking into a durable tool event.
function json(value: unknown) {
  return JSON.parse(JSON.stringify(value))
}

const TOOLS = [
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
]

@inject(ITools)
export class WorktreeTools implements IWorktreeTools {
  declare readonly _serviceBrand: undefined
  readonly names = TOOLS.map((tool) => tool.name)

  constructor(private readonly registry: ToolsService) {}

  register(): void {
    for (const tool of TOOLS) this.registry.register(tool)
  }
}
