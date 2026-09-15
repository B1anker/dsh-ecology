/**
 * The container over the host doubles: one table, reachable both through the
 * context's `get` and through the container's identifiers.
 */

import { afterEach, describe, expect, test } from '@rstest/core'
import { createDecorator, inject, optional, SyncDescriptor } from '@seaveyon/dsh-di'
import { IConnection, IPluginContext, ITools, IWebServer } from '@seaveyon/dsh-di/host'
import { createMockConnection } from '../src/connection.js'
import { createMockServices, type MockServices } from '../src/services.js'
import type { ToolsService, WebServerService } from '../src/types.js'
import { createMockWebServer } from '../src/web-server.js'

let mock: MockServices | undefined

afterEach(async () => {
  await mock?.dispose()
  mock = undefined
})

describe('createMockServices', () => {
  test('the context and the container answer with the same doubles', () => {
    mock = createMockServices()
    expect(mock.ctx.get('webServer')).toBe(mock.web.service)
    expect(mock.ctx.get('connection')).toBe(mock.connection)
    expect(mock.services.get(IWebServer)).toBe(mock.web.service)
    expect(mock.services.get(IConnection)).toBe(mock.connection)
    expect(mock.services.get(IPluginContext)).toBe(mock.ctx)
    // No tools unless asked for: a plugin declaring ITools without it fails
    // loudly rather than getting an empty registry.
    expect(mock.services.has(ITools)).toBe(false)
    expect(mock.ctx.get('tools')).toBeUndefined()
  })

  test('takes the doubles a test already holds', async () => {
    const web = createMockWebServer()
    const connection = createMockConnection(() => 403)
    const tools: ToolsService = { register: () => () => {} }
    mock = createMockServices({ webServer: web, connection, tools })
    expect(mock.web).toBe(web)
    expect(mock.connection).toBe(connection)
    expect(mock.services.get(ITools)).toBe(tools)
    expect(mock.ctx.get('tools')).toBe(tools)
    expect(mock.services.get(IConnection)).toBe(connection)
    expect(connection.requestRejection({ headers: {} })).toBe(403)
  })

  test('further host services register by their Cordis name', () => {
    const ready = { ready: true }
    mock = createMockServices({ services: { dshWebLoginReady: ready } })
    expect(mock.ctx.get('dshWebLoginReady')).toBe(ready)
    expect(mock.services.get(createDecorator<typeof ready>('dshWebLoginReady'))).toBe(ready)
    // The host doubles always win over the table, so a test cannot register a
    // second, disconnected webServer by accident.
    mock = createMockServices({ services: { webServer: { register: () => () => {} } } })
    expect(mock.ctx.get('webServer')).toBe(mock.web.service)
  })

  test('a plugin service resolves its host dependencies from the doubles', async () => {
    @inject(IWebServer, optional(IConnection))
    class Routes {
      constructor(
        readonly web: WebServerService,
        readonly connection: unknown,
      ) {}
      mount(): () => void {
        return this.web.register({
          kind: 'exact',
          path: '/hello',
          handler: (_req, res) => {
            res.writeHead(200, { 'content-type': 'text/plain' })
            res.end('hi')
          },
        })
      }
    }
    const IRoutes = createDecorator<Routes>('test.routes')
    mock = createMockServices({ entries: [[IRoutes, new SyncDescriptor(Routes)]] })
    const routes = mock.services.get(IRoutes)
    expect(routes.connection).toBe(mock.connection)
    routes.mount()
    const port = await mock.web.listen()
    const response = await fetch(`http://127.0.0.1:${port}/hello`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hi')
  })

  test('dispose tears down the container, the context, and the socket', async () => {
    const log: string[] = []
    const IOwned = createDecorator<{ dispose(): void }>('test.owned')
    class Owned {
      dispose(): void {
        log.push('service')
      }
    }
    mock = createMockServices({ entries: [[IOwned, new SyncDescriptor(Owned)]] })
    mock.services.get(IOwned)
    mock.ctx.effect(() => () => {
      log.push('effect')
    })
    const port = await mock.web.listen()
    await mock.dispose()
    expect(log).toEqual(['service', 'effect'])
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    expect(() => mock?.services.get(IOwned)).toThrow(/disposed/)
    mock = undefined
  })
})
