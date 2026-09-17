/**
 * The host plugin's service identifiers and the contract types behind them.
 *
 * Kept apart from the recipes (./services) and the API class (./api) so that
 * both can import the identifiers without importing each other: `@inject`
 * reads an identifier at class-definition time, and a cycle there is a TDZ
 * error at the first import.
 *
 * @module @seaveyon/dsh-world-line/web/identifiers
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createDecorator } from '@seaveyon/dsh-di'
import type { CliContext } from '../context.js'
import type { OperateDeps } from './operations.js'
import type { ReadCache } from './read-cache.js'

/** An ordinary HTTP route handler on the host's `webServer`. */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** The subset of the host `webServer` this plugin registers through. */
export interface WebServerService {
  register(route: { kind: 'exact'; path: string; handler: Handler }): () => void
}

/** The host side of DSH browser authentication. */
export interface ConnectionService {
  requestRejection(req: IncomingMessage): number | undefined
}

/** The Cordis plugin context, as far as this plugin reads it. */
export interface WebContext {
  get<T>(name: string): T | undefined
  effect(fn: () => () => void, label?: string): void
}

/**
 * Host services under their Cordis names and this plugin's own contract
 * types — the same keys `@seaveyon/dsh-di/host` exports.
 */
export const IPluginContext = createDecorator<WebContext>('pluginContext')
export const IWebServer = createDecorator<WebServerService>('webServer')
export const IConnection = createDecorator<ConnectionService>('connection')

/** Where this DSH instance sits in a World Line tree. */
export interface WorldLineLocation {
  /** The running instance's home (`$DSH_HOME`, else `~/.dsh`). */
  readonly runtimeHome: string
  /** The lab this instance is, when it is one; `undefined` for the manager. */
  readonly currentId: string | undefined
  /** The manager's home, from which labs and snapshots are read. */
  readonly home: string
  /** The profile the management surface operates on. */
  readonly profileName: string
}
export const ILocation = createDecorator<WorldLineLocation>('worldLineLocation')

/** The derived-read cache the operations module shares. */
export const IReadCache = createDecorator<ReadCache>('worldLineReadCache')

/** Builds the per-request command context: the manager home's `.env`, re-read each time. */
export interface IContextFactory {
  readonly _serviceBrand: undefined
  create(): Promise<CliContext>
}
export const IContextFactory = createDecorator<IContextFactory>('worldLineContext')

/** The command implementations `operate` dispatches to; empty means the real ones. */
export const IOperateDeps = createDecorator<OperateDeps>('worldLineOperateDeps')

/** The authenticated management API, ready to be registered with the host. */
export interface IManagementApi {
  readonly _serviceBrand: undefined
  readonly path: string
  readonly handler: Handler
  /** Register with the host's `webServer`; the returned disposer unregisters. */
  register(): () => void
}
export const IManagementApi = createDecorator<IManagementApi>('worldLineApi')
