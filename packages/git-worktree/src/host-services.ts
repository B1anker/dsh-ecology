/**
 * The host services this plugin takes, as identifiers.
 *
 * Declared with this package's own hand-written types under the Cordis service
 * names — so they are the same keys `@seaveyon/dsh-di/host` exports, carrying
 * the surface this plugin actually relies on (see `web.ts` for why the types
 * are written by hand rather than imported). Kept apart from the plugin's own
 * services so a service module can `@inject` these without importing the
 * module that registers it.
 *
 * @module @seaveyon/dsh-git-worktree/host-services
 */

import type { defineTool } from '@deepseek-ai/dsh-tools'
import { createDecorator } from '@seaveyon/dsh-di'
import type { ConnectionService, WebServerService } from './web.js'

/** The DSH tools registry, at the surface this plugin uses. */
export interface ToolsService {
  register(tool: ReturnType<typeof defineTool>): unknown
}

/** What `apply` receives, as far as this plugin reads it. */
export interface PluginContext {
  tools: ToolsService
  get<T>(name: string): T | undefined
  effect(fn: () => (() => void) | void, label?: string): void
}

export const IWebServer = createDecorator<WebServerService>('webServer')
export const IConnection = createDecorator<ConnectionService>('connection')
export const ITools = createDecorator<ToolsService>('tools')
