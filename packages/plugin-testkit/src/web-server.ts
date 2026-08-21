/**
 * A minimal stand-in for the dsh `webServer` service.
 *
 * A plugin that guards routes needs a route registry with the same shape as
 * dsh's — `register`, `registerUpgrade`, `registerFallback`, exact and prefix
 * routes, a single fallback seat — but not a real dsh process. This is that
 * registry plus a real `node:http` server, so requests travel over a socket and
 * assertions can cover header and status behaviour end to end.
 *
 * It deliberately mirrors two dsh behaviours a gate depends on: a route table
 * where an exact match wins over a prefix, and a fallback that only fires when
 * nothing else matched. Whether it still mirrors them is not left to inspection;
 * see {@link module:@seaveyon/dsh-plugin-testkit/contract}.
 *
 * @module @seaveyon/dsh-plugin-testkit/web-server
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Route, RouteHandler, UpgradeRoute, WebServerService } from './types.js'

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
  const exact = new Map<string, Route>()
  const prefixes = new Map<string, Route>()
  const upgrades = new Map<string, UpgradeRoute>()
  let fallback: RouteHandler | undefined

  const service: WebServerService = {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) {
        throw new Error(`mock: duplicate ${route.kind} route ${route.path}`)
      }
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
    registerUpgrade(route) {
      if (upgrades.has(route.path)) throw new Error(`mock: duplicate upgrade route ${route.path}`)
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
    registerFallback(handler) {
      if (fallback !== undefined) throw new Error('mock: fallback already claimed')
      fallback = handler
      return () => {
        fallback = undefined
      }
    },
  }

  /** Match exactly as the host does: exact first, then longest segment prefix. */
  const match = (path: string): Route | undefined => {
    const direct = exact.get(path)
    if (direct !== undefined) return direct
    let best: Route | undefined
    for (const [prefix, route] of prefixes) {
      if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  const handle = async (
    req: Parameters<RouteHandler>[0],
    res: Parameters<RouteHandler>[1],
  ): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = match(path)?.handler ?? fallback
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    await handler(req, res)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy())
    let route: UpgradeRoute | undefined
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      route = upgrades.get(path)
    } catch {
      socket.destroy()
      return
    }
    if (route === undefined) {
      socket.destroy()
      return
    }
    try {
      void Promise.resolve(route.handler(req, socket, head)).catch(() => socket.destroy())
    } catch {
      socket.destroy()
    }
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
