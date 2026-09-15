/**
 * The DSH host plugin face of World Line: `apply` mounts the authenticated
 * management API and the background effects around it.
 *
 * The API and its collaborators are composed through `@seaveyon/dsh-di`
 * (./services declares the graph, ./api is the route); this module is the
 * composition root, and re-exports the operations module so existing
 * importers of `web/index.js` — the package entry and the tests — keep
 * their names.
 *
 * @module @seaveyon/dsh-world-line/web
 */

import { InstantiationService } from '@seaveyon/dsh-di'
import { closeProbeResultWindows } from '../lab/browser.js'
import { upgradeTick } from '../workflows/upgrades.js'
import {
  IContextFactory,
  ILocation,
  IManagementApi,
  IReadCache,
  type WebContext,
} from './identifiers.js'
import { watchWorldLine } from './read-cache.js'
import { createServices } from './services.js'

export { API_PATH, ManagementApi } from './api.js'
export type {
  ConnectionService,
  Handler,
  WebContext,
  WebServerService,
  WorldLineLocation,
} from './identifiers.js'
// Each `I*` below is an interface and an identifier of the same name; one
// plain re-export carries both meanings.
export {
  IConnection,
  IContextFactory,
  ILocation,
  IManagementApi,
  IOperateDeps,
  IPluginContext,
  IReadCache,
  IWebServer,
} from './identifiers.js'
export { labStatus, type OperateDeps, operate, readCache, worldLines } from './operations.js'
export { ContextFactory, createServices, locate } from './services.js'

export const name = '@seaveyon/dsh-world-line'
export const inject = ['webServer', 'connection']

export function apply(host: WebContext, config: { profile?: string } = {}): void {
  const services = new InstantiationService(createServices(host, config))
  // Mounted first so it runs last: the route and the timers go before the
  // services behind them.
  host.effect(() => () => services.dispose(), 'world-line: service container')

  const { home } = services.get(ILocation)
  const reads = services.get(IReadCache)
  const context = services.get(IContextFactory)
  host.effect(() => watchWorldLine(home, reads), 'world-line: metadata invalidation')
  host.effect(
    () => () => {
      void closeProbeResultWindows()
    },
    'world-line: result window ownership',
  )
  host.effect(() => {
    let stopped = false
    const tick = () => {
      if (!stopped)
        void context
          .create()
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
  const api = services.get(IManagementApi)
  host.effect(() => api.register(), 'world-line: authenticated management API')
}
