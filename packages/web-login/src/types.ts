/**
 * Structural types for the two host contracts this plugin binds to.
 *
 * These are written by hand rather than imported from `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-host-webserver`. Both are optional peer dependencies — the
 * package must typecheck and build without them installed — and the webserver
 * version this plugin targets (`0.1.0-rc.7`) is not the one published to the
 * public registry, so an import would resolve to a different shape or to
 * nothing at all.
 *
 * Only the members actually touched are declared. That is the point: the
 * surface below *is* the compatibility contract, so a host change that breaks
 * this plugin shows up as a type error in one file instead of as a runtime
 * failure spread across nine.
 *
 * @module @seaveyon/dsh-web-login/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Handler for an ordinary HTTP route. May be sync or async. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Handler for a protocol upgrade; there is no ServerResponse to answer with. */
export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>

/**
 * How a route claims paths.
 *
 * `exact` matches one path; `prefix` matches everything beneath it. The
 * distinction decides whether an unauthenticated request may be redirected to
 * the login page — see the guard in {@link module:@seaveyon/dsh-web-login}.
 */
export type RouteKind = 'exact' | 'prefix'

/** A route registration as the dsh webServer registry accepts it. */
export interface Route {
  kind: RouteKind
  path: string
  handler: RouteHandler
}

/** An exact-path HTTP upgrade registration. */
export interface UpgradeRoute {
  path: string
  handler: UpgradeHandler
}

/** Undoes a registration. Returned by every register call. */
export type Disposer = () => void

/**
 * The subset of the dsh `webServer` service this plugin uses.
 *
 * The three register methods are mutable properties rather than methods,
 * because the gate works by *replacing* them with wrappers. Declaring them as
 * methods would still compile, but writing the contract this way states the
 * requirement: they have to be reassignable for the gate to exist at all.
 */
export interface WebServerService {
  register: (route: Route) => Disposer
  registerUpgrade: (route: UpgradeRoute) => Disposer
  registerFallback: (handler: RouteHandler) => Disposer
}

/** The logger Cordis hands to a plugin. */
export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
}

/**
 * The subset of the Cordis plugin context this plugin uses.
 *
 * `provide` and `set` are optional because the plugin calls them with `?.` —
 * it tolerates a host that predates the service registry rather than failing
 * to load. `effect` is not optional: without it there is no disposal path, and
 * a gate that cannot be torn down would leave its decoration on the registry
 * after the plugin unloads.
 */
export interface PluginContext {
  get: <T = unknown>(name: string) => T | undefined
  effect: (setup: () => void | Disposer, label?: string) => void
  logger: Logger
  provide?: (name: string, value: unknown, available?: () => boolean) => void
  set?: (name: string, value: unknown) => void
}
