/**
 * The dsh host surfaces these doubles stand in for.
 *
 * Declared structurally and by hand, for the same reason a plugin binding to
 * this host declares them by hand: `@deepseek-ai/dsh-host-webserver` and
 * `@deepseek-ai/cordis` are not on the public registry at the version this
 * describes, so an import would resolve to a different shape or to nothing.
 *
 * A package under test will have its own copy of these. That is not duplication
 * to be eliminated — it is the plugin's compatibility contract, which belongs in
 * the plugin — but the two must agree, and structural typing makes agreement
 * something a test can assert rather than something a reviewer has to check.
 *
 * Event and tools members below are likewise structural. They describe the
 * cookbook shapes a hook plugin binds to (`tools/pre-execute` decisions, Cordis
 * waterfall listeners), not a complete `@deepseek-ai/dsh-tools` surface.
 *
 * @module @seaveyon/dsh-plugin-testkit/types
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

/** `exact` matches one path; `prefix` matches everything beneath it. */
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
 * The dsh `webServer` route registry.
 *
 * The three register members are properties rather than methods because a
 * plugin that guards routes works by replacing them. Declaring them this way
 * states the requirement instead of merely permitting it.
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
 * A Cordis event listener.
 *
 * For waterfall events the final argument is `next`. Ordinary `emit` listeners
 * receive only the payload.
 */
export type ContextListener = (...args: never[]) => unknown

/**
 * The Cordis plugin context.
 *
 * `provide`, `set`, and the event members are optional because a plugin is
 * expected to call them defensively; `effect` is not, because without it there
 * is no disposal path. The mock always implements the optionals.
 */
export interface PluginContext {
  get: <T = unknown>(name: string) => T | undefined
  effect: (setup: () => void | Disposer, label?: string) => void
  logger: Logger
  provide?: (name: string, value: unknown, available?: () => boolean) => void
  set?: (name: string, value: unknown) => void
  on?: (event: string, listener: ContextListener) => Disposer
  emit?: (event: string, ...args: unknown[]) => void
  waterfall?: (event: string, ...args: unknown[]) => unknown
}

/** Opaque execution identity carried through the tools pipeline. */
export interface ToolExecution {
  callId: string
  name: string
  arguments: unknown
  signal: AbortSignal
  token: string
}

/** Decision returned from a `tools/pre-execute` waterfall listener. */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/** Normalized outcome after the tools pipeline settles. */
export interface ToolResult {
  content: unknown
  isError: boolean
}

/** Minimal tools registry surface a hook plugin `get`s. */
export interface ToolsService {
  register: (name: string, execute: ToolBody) => Disposer
}

/** The body a registered tool runs when pre-execute allows it. */
export type ToolBody = (exec: ToolExecution) => unknown | Promise<unknown>

/**
 * Prove two structural types remain mutually substitutable.
 *
 * Compiles only while each side is assignable to the other. The runtime body is
 * a no-op; `typecheck` is what enforces the claim.
 *
 * @param _ab - witness that `A` is assignable to `B`.
 * @param _ba - witness that `B` is assignable to `A`.
 */
export function assertMutualAssignability<A, B>(_ab: (a: A) => B, _ba: (b: B) => A): void {
  /* type-level only */
}
