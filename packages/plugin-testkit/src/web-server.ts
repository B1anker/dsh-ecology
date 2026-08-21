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
        // Only release the slot while this handler still holds it. Cordis may
        // unwind a context twice, and a plugin reloaded in between has already
        // claimed the slot again — an unconditional clear would drop the live
        // fallback on behalf of a handler that is long gone. `register` and
        // `registerUpgrade` are identity-checked for the same reason.
        if (fallback === handler) fallback = undefined
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
