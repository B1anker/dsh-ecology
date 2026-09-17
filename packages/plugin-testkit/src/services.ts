/**
 * A service container over the host doubles.
 *
 * A plugin composed through `@seaveyon/dsh-di` reaches the host's services by
 * identifier — `@inject(IWebServer, IConnection)` — instead of `ctx.get(name)`.
 * Testing one of its services directly then needs a container in which those
 * identifiers resolve to doubles, and testing its `apply` needs a context whose
 * `get` answers with the *same* doubles. This builds both from one table, so a
 * test can drive the plugin either way and inspect the same mock afterwards.
 *
 * ```ts
 * const mock = createMockServices()
 * const api = mock.services.createInstance(WorktreeApi)   // IWebServer, IConnection → doubles
 * const port = await mock.web.listen()
 * mock.connection.rejectWhen(() => 401)
 * await mock.dispose()
 * ```
 *
 * Nothing here is for production use.
 *
 * @module @seaveyon/dsh-plugin-testkit/services
 */

import {
  createDecorator,
  InstantiationService,
  ServiceCollection,
  type ServiceIdentifier,
} from '@seaveyon/dsh-di'
import { IConnection, IPluginContext, ITools, IWebServer } from '@seaveyon/dsh-di/host'
import { createMockConnection, type MockConnection } from './connection.js'
import { createMockContext, type MockContext } from './context.js'
import type { ToolsService } from './types.js'
import { createMockWebServer, type MockWebServer } from './web-server.js'

export interface MockServicesOptions {
  /** The `webServer` double; a fresh `createMockWebServer()` when omitted. */
  webServer?: MockWebServer
  /** The `connection` double; a fresh, accept-everything `createMockConnection()` when omitted. */
  connection?: MockConnection
  /** A `tools` service, registered under `ITools` and on the context when given. */
  tools?: ToolsService
  /**
   * Further host services by Cordis name. Each is placed on the context and
   * registered under `createDecorator(name)`, which is the key a plugin
   * declaring that name resolves by.
   */
  services?: Record<string, unknown>
  /**
   * Entries added to the collection after the host doubles — the plugin's own
   * recipes, or overrides of them. Later entries win.
   */
  entries?: Iterable<readonly [ServiceIdentifier<unknown>, unknown]>
}

export interface MockServices {
  /** A context whose `get` answers with the same doubles the container holds. */
  ctx: MockContext
  /** The collection, for a test that wants to register more before resolving. */
  collection: ServiceCollection
  /** The container over `collection`. */
  services: InstantiationService
  web: MockWebServer
  connection: MockConnection
  /** Disposes the container, the context, and the web server's socket, in that order. */
  dispose: () => Promise<void>
}

/**
 * Build a context and a container that share one table of host doubles.
 * @param options - which doubles to use, and what else to register.
 */
export function createMockServices(options: MockServicesOptions = {}): MockServices {
  const web = options.webServer ?? createMockWebServer()
  const connection = options.connection ?? createMockConnection()
  const table: Record<string, unknown> = {
    ...options.services,
    webServer: web.service,
    connection,
  }
  if (options.tools !== undefined) table.tools = options.tools
  const ctx = createMockContext(table)

  const collection = new ServiceCollection()
  collection.set(IPluginContext, ctx)
  collection.set(IWebServer, web.service)
  collection.set(IConnection, connection)
  if (options.tools !== undefined) collection.set(ITools, options.tools)
  for (const [name, service] of Object.entries(options.services ?? {})) {
    collection.set(createDecorator<unknown>(name), service)
  }
  for (const [id, entry] of options.entries ?? []) collection.set(id, entry as never)
  const services = new InstantiationService(collection)

  return {
    ctx,
    collection,
    services,
    web,
    connection,
    async dispose() {
      services.dispose()
      await ctx.dispose()
      await web.close()
    },
  }
}
