/**
 * DSH host services as identifiers, and the bridge from a Cordis plugin
 * context into a {@link ServiceCollection}.
 *
 * A DSH plugin's `apply(ctx)` finds the host's services on the context by
 * name — `ctx.get('webServer')`, `ctx.get('connection')`. This module gives
 * those names identifiers so the plugin's own services can declare them with
 * `@inject(IWebServer)` like any other dependency, and one call that copies
 * them from the context into a collection as ready instances (the host owns
 * them; the container never disposes them).
 *
 * The identifier *names* are the Cordis service names. That is what makes the
 * bridge one line per service, and it has a second consequence worth knowing:
 * `createDecorator<T>(name)` returns one object per name, so a plugin that has
 * a richer hand-written type for a host service than the minimal shapes below
 * declares `createDecorator<ItsOwnType>('webServer')` and gets the same key.
 * The shapes here are deliberately the least a plugin can rely on; the
 * plugin's own contract file remains the place its compatibility promise lives.
 *
 * Type-only imports from `node:http`: this module runs anywhere the rest of
 * the package does, but a plugin's route handlers are Node's, and describing
 * them as anything else would only push a cast onto every consumer.
 *
 * @module @seaveyon/dsh-di/host
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServiceCollection } from './collection.js'
import { type ServiceIdentifier } from './identifier.js'
/** The Cordis plugin context, as far as this module reads it. */
export interface HostContext {
  get: <T = unknown>(name: string) => T | undefined
}
/** An ordinary HTTP route handler on the DSH `webServer`. */
export type HostRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
/** The DSH `webServer` route registry, at the surface every plugin here uses. */
export interface HostWebServer {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: HostRouteHandler
  }) => () => void
}
/**
 * The host side of DSH browser authentication: `requestRejection` applies the
 * configured Host/Origin fence and session check and answers with the status
 * to reject with, or `undefined` when the request may proceed.
 */
export interface HostConnection {
  requestRejection: (request: IncomingMessage) => number | undefined
}
/**
 * The DSH tools registry. Its `register` signature differs between the tools
 * package's `defineTool` objects and the cookbook `(name, body)` form, so only
 * the member's existence is promised here; a plugin declares the arguments it
 * relies on in its own contract.
 */
export interface HostTools {
  register: (...args: never[]) => unknown
}
/** The plugin context itself, for services that log or register effects. */
export declare const IPluginContext: ServiceIdentifier<HostContext>
export declare const IWebServer: ServiceIdentifier<HostWebServer>
export declare const IConnection: ServiceIdentifier<HostConnection>
export declare const ITools: ServiceIdentifier<HostTools>
/**
 * Copy host services from the plugin context into a collection, by name.
 *
 * ```ts
 * const collection = registerHostServices(new ServiceCollection(), ctx, {
 *   required: [IWebServer, ITools],
 *   optional: [IConnection],
 * })
 * ```
 *
 * `required` services must be present; a missing one throws naming it, so the
 * plugin fails at `apply` rather than at the first request. `optional` ones
 * are copied when present and skipped otherwise, which is what lets a service
 * declare `optional(IConnection)` and receive `undefined` on a host without
 * it. The context itself is registered under {@link IPluginContext}.
 *
 * @returns the same collection, for chaining.
 */
export declare function registerHostServices(
  collection: ServiceCollection,
  ctx: HostContext,
  services: {
    required?: readonly ServiceIdentifier<unknown>[]
    optional?: readonly ServiceIdentifier<unknown>[]
  },
): ServiceCollection
