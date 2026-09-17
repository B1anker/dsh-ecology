/**
 * The plugin's service graph in one place: what it takes from the host and
 * what it builds on top.
 *
 * The host services are ready instances copied off the plugin context; the
 * plugin's own two services are recipes the container builds on first use and
 * disposes with the plugin. A test wanting the real graph over doubles calls
 * {@link createServices}, `clone()`s the result, and overrides an entry.
 *
 * @module @seaveyon/dsh-git-worktree/services
 */

import { ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'
import { IPluginContext, registerHostServices } from '@seaveyon/dsh-di/host'
import { IWorktreeApi, WorktreeApi } from './api.js'
import { IConnection, ITools, IWebServer, type PluginContext } from './host-services.js'
import { IWorktreeTools, WorktreeTools } from './tools.js'
import type { ConnectionService, WebServerService } from './web.js'

export { IConnection, IPluginContext, ITools, IWebServer, IWorktreeApi, IWorktreeTools }

/**
 * The collection `apply` builds its container from.
 *
 * `connection` is checked by hand rather than left to `registerHostServices`
 * so the error carries the reason the plugin refuses to start without it: the
 * management API runs `git worktree add/remove` on a caller-supplied `cwd`,
 * and must not exist unfenced.
 */
export function createServices(ctx: PluginContext): ServiceCollection {
  const registry = ctx.get<WebServerService>('webServer')
  if (registry === undefined) throw new Error('dsh-git-worktree: webServer service missing')
  const connection = ctx.get<ConnectionService>('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function')
    throw new Error(
      'dsh-git-worktree: connection service missing; the management API must stay behind DSH browser authentication',
    )

  const collection = registerHostServices(new ServiceCollection(), ctx, {
    required: [IWebServer, IConnection],
  })
  // `tools` arrives as a property of the context, not through `get`.
  collection.set(ITools, ctx.tools)
  collection.set(IWorktreeApi, new SyncDescriptor(WorktreeApi))
  collection.set(IWorktreeTools, new SyncDescriptor(WorktreeTools))
  return collection
}
