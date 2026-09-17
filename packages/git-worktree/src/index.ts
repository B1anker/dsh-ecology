import { InstantiationService } from '@seaveyon/dsh-di'
import type { PluginContext } from './host-services.js'
import { createServices, IWorktreeApi, IWorktreeTools } from './services.js'

export type { ManagementRoute } from './api.js'
export type { GitFailureKind } from './git.js'
export {
  assertBranchName,
  createWorktree,
  GitWorktreeError,
  listWorktrees,
  repositoryRoot,
} from './git.js'
export type { PluginContext, ToolsService } from './host-services.js'
// `IWorktreeApi` and `IWorktreeTools` are each an interface and an identifier
// of the same name; one plain re-export carries both meanings.
export {
  createServices,
  IConnection,
  IPluginContext,
  ITools,
  IWebServer,
  IWorktreeApi,
  IWorktreeTools,
} from './services.js'
export type { ConnectionService } from './web.js'

export const name = 'dsh-git-worktree'
/**
 * `connection` is the host side of DSH browser authentication. It is injected
 * (not merely looked up) so the loader never starts this plugin on a host
 * without it: the management API runs `git worktree add/remove` on a
 * caller-supplied `cwd`, and must not exist unfenced.
 */
export const inject = ['tools', 'webServer', 'connection']

/**
 * The composition root. Builds the service graph (`services.ts`) over the
 * host's `tools`, `webServer` and `connection`, then mounts the two services
 * it has: the management API — one effect per route, so the host sees each
 * registration by name — and the agent tools. The container is disposed with
 * the plugin, after the routes it registered are gone.
 */
export function apply(ctx: PluginContext) {
  const services = new InstantiationService(createServices(ctx))
  ctx.effect(() => () => services.dispose(), 'dsh-git-worktree: service container')

  const api = services.get(IWorktreeApi)
  for (const route of api.routes) {
    ctx.effect(() => api.register(route), `dsh-git-worktree: ${route.label}`)
  }
  services.get(IWorktreeTools).register()
}
