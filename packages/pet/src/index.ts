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
 * routes, no services — nothing else to break when the host moves.
 */

import type { HostContext, WebServerService } from './host-types.js'
import { createLaunchHandler, LAUNCH_ROUTE_PATH } from './launch.js'

export const name = 'dsh-pet'

// webServer is the route registry; dshWebLoginReady is the ordering guarantee
// that the login gate has decorated that registry before this route
// registers — web-login's cordis.patch.yml makes the inject a rule for every
// route-owning row, because without it the route can bypass the gate.
export const inject = ['webServer', 'dshWebLoginReady']

export function apply(ctx: HostContext): void {
  const server = ctx.get<WebServerService>('webServer')
  if (server === undefined) return
  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: LAUNCH_ROUTE_PATH,
        handler: createLaunchHandler(),
      }),
    'dsh-pet: launch-desktop route',
  )
}
