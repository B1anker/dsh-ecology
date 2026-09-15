/**
 * Host entry: one route, nothing else.
 *
 * The client module system only discovers packages that sit in the host
 * Loader's tree (see cordis.patch.yml), and a Loader row must resolve to a
 * loadable plugin module — so the package needs a host face even though
 * nearly every feature lives in the browser bundle. The single exception is
 * the desktop-app launch route: the panel cannot start a local process from
 * the browser, but this face runs inside the DSH server, which for a loopback
 * page is the user's own machine (see src/launch.ts for the guards). No other
 * routes — nothing else to break when the host moves.
 *
 * The route and the launcher behind it are composed through
 * `@seaveyon/dsh-di` (see src/services.ts), like every plugin here: `apply`
 * builds the container, registers the one route, and disposes the container
 * with the plugin.
 */

import { InstantiationService } from '@seaveyon/dsh-di'
import type { HostContext } from './host-types.js'
import { createServices, ILaunchRoute } from './services.js'

export type { Disposer, HostContext, Route, RouteHandler, WebServerService } from './host-types.js'
export type { LaunchDeps, LaunchOutcome } from './launch.js'
// `IDesktopLauncher` and `ILaunchRoute` are each an interface and an
// identifier of the same name; one plain re-export carries both meanings.
export {
  createServices,
  DesktopLauncher,
  IDesktopLauncher,
  ILaunchRoute,
  IWebServer,
  LaunchRoute,
} from './services.js'

export const name = 'dsh-pet'

// webServer is the route registry; dshWebLoginReady is the ordering guarantee
// that the login gate has decorated that registry before this route
// registers — web-login's cordis.patch.yml makes the inject a rule for every
// route-owning row, because without it the route can bypass the gate.
export const inject = ['webServer', 'dshWebLoginReady']

export function apply(ctx: HostContext): void {
  // A host without the registry loads to a no-op rather than a failed row:
  // the client bundle — the whole product — does not depend on this route.
  if (ctx.get('webServer') === undefined) return
  const services = new InstantiationService(createServices(ctx))
  ctx.effect(() => () => services.dispose(), 'dsh-pet: service container')
  const route = services.get(ILaunchRoute)
  ctx.effect(() => route.register(), 'dsh-pet: launch-desktop route')
}
