/**
 * Hand-written types for the host (Node.js) contracts this plugin binds to.
 *
 * Same trade-off as the client side's client/host-types.ts and web-login's
 * src/types.ts: `@deepseek-ai/dsh-host-webserver` is an optional peer that is
 * not on the public registry, so the surface is declared from the observed
 * runtime contract and `scripts/check-host-contract.mjs` re-verifies the named
 * members whenever the real packages are installed. Only the members the host
 * face touches are declared — the surface below IS the compatibility contract.
 *
 * @module @seaveyon/dsh-pet/host-types
 */

/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Handler for an ordinary HTTP route. May be sync or async. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** A route registration as the dsh webServer registry accepts it. */
export interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** Undoes a registration. Returned by every register call. */
export type Disposer = () => void

/** The subset of the dsh `webServer` service the launch route needs. */
export interface WebServerService {
  register: (route: Route) => Disposer
}

/**
 * The subset of the Cordis plugin context the host face uses. `effect` is not
 * optional: without it the route registration has no disposal path and would
 * outlive the plugin that owns it.
 */
export interface HostContext {
  get: <T = unknown>(name: string) => T | undefined
  effect: (setup: () => void | Disposer, label?: string) => void
}
