/**
 * The bridge from a Cordis plugin context into a collection.
 */

import { describe, expect, test } from '@rstest/core'
import { ServiceCollection } from '../src/collection.js'
import {
  type HostContext,
  IConnection,
  IPluginContext,
  ITools,
  IWebServer,
  registerHostServices,
} from '../src/host.js'
import { createDecorator, inject, optional } from '../src/identifier.js'
import { InstantiationService } from '../src/instantiation.js'

function contextWith(services: Record<string, unknown>): HostContext {
  return { get: <T>(name: string) => services[name] as T | undefined }
}

describe('host identifiers', () => {
  test('are named after the Cordis services they stand for', () => {
    expect(String(IWebServer)).toBe('webServer')
    expect(String(IConnection)).toBe('connection')
    expect(String(ITools)).toBe('tools')
    expect(String(IPluginContext)).toBe('pluginContext')
  })

  test('a plugin with a richer type gets the same key by name', () => {
    interface Richer {
      register: (route: { kind: 'exact'; path: string }) => () => void
      registerUpgrade: () => () => void
    }
    expect(createDecorator<Richer>('webServer')).toBe(IWebServer)
  })
})

describe('registerHostServices', () => {
  test('copies required and present optional services, and the context itself', () => {
    const webServer = { register: () => () => {} }
    const tools = { register: () => undefined }
    const ctx = contextWith({ webServer, tools })
    const collection = new ServiceCollection()

    const returned = registerHostServices(collection, ctx, {
      required: [IWebServer, ITools],
      optional: [IConnection],
    })

    expect(returned).toBe(collection)
    expect(collection.get(IWebServer)).toBe(webServer)
    expect(collection.get(ITools)).toBe(tools)
    expect(collection.get(IPluginContext)).toBe(ctx)
    expect(collection.has(IConnection)).toBe(false)
  })

  test('a missing required service fails at registration, by name', () => {
    const ctx = contextWith({ webServer: { register: () => () => {} } })
    expect(() =>
      registerHostServices(new ServiceCollection(), ctx, { required: [IWebServer, IConnection] }),
    ).toThrow("Host service 'connection' is not available on this plugin context")
  })

  test('an optional service present on the host is registered', () => {
    const connection = { requestRejection: () => undefined }
    const collection = registerHostServices(new ServiceCollection(), contextWith({ connection }), {
      optional: [IConnection],
    })
    expect(collection.get(IConnection)).toBe(connection)
  })

  test('host services are ready instances: injected as-is and never disposed', () => {
    let disposed = 0
    const webServer = {
      register: () => () => {},
      dispose: () => {
        disposed += 1
      },
    }
    @inject(IWebServer, optional(IConnection))
    class Routes {
      constructor(
        readonly web: typeof webServer,
        readonly connection: unknown,
      ) {}
    }
    const collection = registerHostServices(new ServiceCollection(), contextWith({ webServer }), {
      required: [IWebServer],
      optional: [IConnection],
    })
    const services = new InstantiationService(collection)
    const routes = services.createInstance(Routes)
    expect(routes.web).toBe(webServer)
    expect(routes.connection).toBeUndefined()
    services.dispose()
    expect(disposed).toBe(0)
  })

  test('with nothing asked for it still registers the context', () => {
    const ctx = contextWith({})
    const collection = registerHostServices(new ServiceCollection(), ctx, {})
    expect(collection.size).toBe(1)
    expect(collection.get(IPluginContext)).toBe(ctx)
  })
})
