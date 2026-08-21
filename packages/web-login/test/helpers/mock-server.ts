/**
 * A minimal stand-in for the dsh `webServer` service.
 *
 * The integration tests need a route registry with the same shape as dsh's —
 * `register`, `registerUpgrade`, `registerFallback`, exact and prefix routes, a
 * single fallback seat — but not a real dsh process. This mock is that registry
 * plus a real `node:http` server, so requests travel over a socket and the
 * assertions cover header and status behavior end to end.
 *
 * It deliberately mirrors two dsh behaviors the plugin depends on: a route table
 * where an exact match wins over a prefix, and a fallback that only fires when
 * nothing else matched.
 *
 * Both mocks implement the interfaces from `src/types.ts` rather than being
 * cast to them, which is the point of declaring those structurally: if the
 * plugin starts using a context member the real host provides but this mock does
 * not, the failure is a type error here.
 *
 * @module test/helpers/mock-server
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  Disposer,
  Logger,
  PluginContext,
  Route,
  RouteHandler,
  UpgradeRoute,
  WebServerService,
} from '../../src/types.js'

/** The mock service plus the controls a test needs over its socket. */
export interface MockWebServer {
  service: WebServerService
  /** Bind to an ephemeral port. @returns the chosen port. */
  listen: () => Promise<number>
  close: () => Promise<void>
}

/**
 * Create the mock service and its HTTP server.
 * @returns the `webServer` stand-in, plus `listen`/`close`.
 */
export function createMockWebServer(): MockWebServer {
  const routes: Route[] = []
  const upgrades: UpgradeRoute[] = []
  let fallback: RouteHandler | undefined

  const service: WebServerService = {
    register(route) {
      const clash = routes.find((r) => r.kind === route.kind && r.path === route.path)
      if (clash !== undefined) {
        throw new Error(`mock: duplicate ${route.kind} route ${route.path}`)
      }
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => {
        const index = upgrades.indexOf(route)
        if (index !== -1) upgrades.splice(index, 1)
      }
    },
    registerFallback(handler) {
      if (fallback !== undefined) throw new Error('mock: fallback already claimed')
      fallback = handler
      return () => {
        fallback = undefined
      }
    },
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const exact = routes.find((r) => r.kind === 'exact' && r.path === path)
    const prefix = routes.find((r) => r.kind === 'prefix' && path.startsWith(r.path))
    const handler = exact?.handler ?? prefix?.handler ?? fallback
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end(error instanceof Error ? error.message : 'error')
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = upgrades.find((r) => path.startsWith(r.path))
    if (route === undefined) {
      socket.destroy()
      return
    }
    route.handler(req, socket, head)
  })

  return {
    service,
    async listen() {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve)
      })
      return (server.address() as AddressInfo).port
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

/** What the plugin logged, split by level. */
export interface CapturedLogs {
  info: string[]
  warn: string[]
}

/** A registered teardown and the label the plugin gave it. */
export interface CapturedTeardown {
  teardown: Disposer
  label: string | undefined
}

/** The mock context, plus the state a test inspects afterwards. */
export interface MockContext extends PluginContext {
  teardowns: CapturedTeardown[]
  logs: CapturedLogs
  /** Run every teardown in reverse order, as Cordis does on disposal. */
  dispose: () => void
}

/**
 * A Cordis-like context sufficient for the plugin's use of it.
 * @param services - services the plugin will `get`.
 * @returns the context, plus the collected teardown callbacks and log lines.
 */
export function createMockContext(services: Record<string, unknown>): MockContext {
  const teardowns: CapturedTeardown[] = []
  const logs: CapturedLogs = { info: [], warn: [] }
  const logger: Logger = {
    info: (line) => logs.info.push(line),
    warn: (line) => logs.warn.push(line),
  }
  return {
    get: <T>(name: string) => services[name] as T | undefined,
    effect(setup, label) {
      const teardown = setup()
      if (typeof teardown === 'function') teardowns.push({ teardown, label })
    },
    set(name, value) {
      services[name] = value
    },
    logger,
    teardowns,
    logs,
    dispose() {
      for (const { teardown } of [...teardowns].toReversed()) teardown()
    },
  }
}
