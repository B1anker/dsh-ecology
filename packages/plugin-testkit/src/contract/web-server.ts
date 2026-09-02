/** Runner-independent scenarios for the narrow DSH webServer registry seam. */

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import type { ContractCase, DisposableDriver } from '../harness.js'
import type { RouteHandler, WebServerService } from '../types.js'

/** A web registry plus the socket lifecycle needed to observe it. */
export interface WebServerContractDriver extends DisposableDriver {
  service: WebServerService
  listen: () => Promise<number>
}

function get(port: number, path: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function upgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      )
    })
    socket.on('data', (chunk: string) => {
      response += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(response))
  })
}

function respond(body: string): RouteHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  }
}

function assertWritable<K extends keyof WebServerService>(
  service: WebServerService,
  member: K,
): void {
  const original = service[member]
  const sentinel = (() => () => undefined) as WebServerService[K]
  assert.doesNotThrow(
    () => {
      service[member] = sentinel
    },
    `${String(member)} must accept replacement`,
  )
  // Cordis may proxy and bind a service method on every read, so reference
  // identity is not observable across a real host. The following decoration
  // scenario proves that the assigned register implementation is actually
  // reached by a later route owner.
  service[member] = original
}

/**
 * Stable, portable web registry behaviours. A real adapter may expose more
 * webServer APIs, but only these claims are made by this package's mock.
 */
export const webServerContractCases: readonly ContractCase<WebServerContractDriver>[] = [
  {
    id: 'webserver.registry.writable',
    title: 'registry members accept replacement',
    run: ({ service }) => {
      assertWritable(service, 'register')
      assertWritable(service, 'registerUpgrade')
      assertWritable(service, 'registerFallback')
    },
  },
  {
    id: 'webserver.registry.decoration',
    title: 'a later caller reaches a register replacement',
    run: async ({ service, listen }) => {
      const original = service.register.bind(service)
      let seen = 0
      service.register = (route) => {
        seen += 1
        return original({ ...route, handler: respond('wrapped') })
      }
      const port = await listen()
      service.register({ kind: 'exact', path: '/late', handler: respond('original') })
      assert.equal(seen, 1)
      assert.equal((await get(port, '/late')).body, 'wrapped')
    },
  },
  {
    id: 'webserver.routes.disposer',
    title: 'route disposers remove their route',
    run: async ({ service, listen }) => {
      const port = await listen()
      const dispose = service.register({ kind: 'exact', path: '/gone', handler: respond('here') })
      assert.equal((await get(port, '/gone')).body, 'here')
      dispose()
      assert.equal((await get(port, '/gone')).status, 404)
    },
  },
  {
    id: 'webserver.routes.precedence',
    title: 'exact routes and longest segment prefixes win',
    run: async ({ service, listen }) => {
      const port = await listen()
      service.register({ kind: 'prefix', path: '/api', handler: respond('shallow') })
      service.register({ kind: 'prefix', path: '/api/deep', handler: respond('deep') })
      service.register({ kind: 'exact', path: '/api/deep/item', handler: respond('exact') })
      assert.equal((await get(port, '/api/deep/item')).body, 'exact')
      assert.equal((await get(port, '/api/deep/else')).body, 'deep')
      assert.equal((await get(port, '/api/else')).body, 'shallow')
      assert.equal((await get(port, '/apix')).status, 404)
    },
  },
  {
    id: 'webserver.routes.fallback',
    title: 'fallback answers only unmatched routes',
    run: async ({ service, listen }) => {
      const port = await listen()
      service.register({ kind: 'exact', path: '/known', handler: respond('known') })
      const dispose = service.registerFallback(respond('spa'))
      assert.equal((await get(port, '/known')).body, 'known')
      assert.equal((await get(port, '/anything/else')).body, 'spa')
      dispose()
      assert.equal((await get(port, '/anything/else')).status, 404)
    },
  },
  {
    id: 'webserver.routes.handler-error',
    title: 'a rejected handler becomes an empty 400 and leaves the server healthy',
    run: async ({ service, listen }) => {
      const port = await listen()
      service.register({
        kind: 'exact',
        path: '/rejects',
        handler: () => Promise.reject(new Error('not response content')),
      })
      service.register({ kind: 'exact', path: '/healthy', handler: respond('healthy') })
      assert.deepEqual(await get(port, '/rejects'), { status: 400, body: '' })
      assert.equal((await get(port, '/healthy')).body, 'healthy')
    },
  },
  {
    id: 'webserver.upgrades.exact-disposable',
    title: 'upgrades are exact-path, unique, and disposable',
    run: async ({ service, listen }) => {
      const port = await listen()
      const dispose = service.registerUpgrade({
        path: '/ws',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
          socket.end()
        },
      })
      assert.throws(
        () => service.registerUpgrade({ path: '/ws', handler: () => undefined }),
        /duplicate/,
      )
      assert.match(await upgrade(port, '/ws?room=1'), /^HTTP\/1\.1 101 /)
      assert.equal(await upgrade(port, '/ws/room'), '')
      dispose()
      assert.equal(await upgrade(port, '/ws'), '')
    },
  },
]
