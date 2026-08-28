/**
 * The contract a dsh `webServer` registry has to satisfy.
 *
 * {@link module:@seaveyon/dsh-plugin-testkit/types} states the *shape*. This
 * states the *behaviour*, as a suite any implementation can be run through: the
 * mock in this package, and a real host adapter whenever one can be installed.
 * Written once and parameterised rather than asserted inline, because a mock
 * that drifts from the host is worse than no mock — every test against it keeps
 * passing while the thing they describe stops being true.
 *
 * The first assertion is the load-bearing one for any plugin that guards
 * routes. Such a plugin works by replacing the three registry members with
 * wrappers, so "these are writable properties, and a later caller sees the
 * replacement" is not an implementation detail of a mock; it is the mechanism
 * the whole approach rests on.
 *
 * Importing this pulls in `@rstest/core`, which is an optional peer: the module
 * declares tests, so it is only usable from inside a runner.
 *
 * @module @seaveyon/dsh-plugin-testkit/contract-web-server
 */

import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { expect, test } from '@rstest/core'
import type { RouteHandler, WebServerService } from './types.js'

/** A registry implementation plus the socket controls needed to exercise it. */
export interface WebServerHarness {
  service: WebServerService
  /** Bind to an ephemeral port. @returns the chosen port. */
  listen: () => Promise<number>
  close: () => Promise<void>
}

/**
 * Fetch a path and return its status and body.
 * @param port - the harness's port.
 * @param path - request target.
 * @returns the status code and decoded body.
 */
function get(port: number, path: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Perform a raw upgrade handshake.
 * @param port - the harness's port.
 * @param path - upgrade target.
 * @returns everything the server sent before closing.
 */
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

/**
 * A handler that answers with a fixed body.
 * @param body - what to send.
 * @returns the handler.
 */
function respond(body: string): RouteHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  }
}

/**
 * Run `body` against a fresh harness, closing it afterwards.
 * @param create - the harness factory.
 * @param body - the test itself.
 */
async function withHarness(
  create: () => WebServerHarness,
  body: (harness: WebServerHarness, port: number) => Promise<void>,
): Promise<void> {
  const harness = create()
  const port = await harness.listen()
  try {
    await body(harness, port)
  } finally {
    await harness.close()
  }
}

/**
 * Assert that one registry member can be replaced and read back.
 * @param service - the registry under test.
 * @param member - the member to replace.
 */
function assertWritable<K extends keyof WebServerService>(
  service: WebServerService,
  member: K,
): void {
  const original = service[member]
  const sentinel = (() => () => undefined) as WebServerService[K]
  service[member] = sentinel
  expect(service[member], member).toBe(sentinel)
  service[member] = original
}

/**
 * Assert that an implementation satisfies the registry contract.
 *
 * @param label - names the implementation in each test title.
 * @param create - produces a fresh, unbound harness.
 */
export function runWebServerContract(label: string, create: () => WebServerHarness): void {
  test(`${label}: the registry members are writable properties`, () => {
    const service = create().service
    // Not a style preference. If a host exposes these as prototype accessors or
    // freezes the service, a guard's assignment silently does nothing and every
    // route it believes it protects is served open.
    assertWritable(service, 'register')
    assertWritable(service, 'registerUpgrade')
    assertWritable(service, 'registerFallback')
  })

  test(`${label}: a later caller reaches the replacement, not the original`, async () => {
    await withHarness(create, async ({ service }, port) => {
      const original = service.register.bind(service)
      let seen = 0
      service.register = (route) => {
        seen += 1
        return original({ ...route, handler: respond('wrapped') })
      }

      // Route owners hold the service, not a bound method, which is what lets a
      // decoration reach plugins loaded after the one that installed it.
      service.register({ kind: 'exact', path: '/late', handler: respond('original') })
      expect(seen).toBe(1)
      expect((await get(port, '/late')).body).toBe('wrapped')
    })
  })

  test(`${label}: register returns a disposer that removes the route`, async () => {
    await withHarness(create, async ({ service }, port) => {
      const dispose = service.register({ kind: 'exact', path: '/gone', handler: respond('here') })
      expect(typeof dispose).toBe('function')
      expect((await get(port, '/gone')).body).toBe('here')
      dispose()
      expect((await get(port, '/gone')).status).toBe(404)
    })
  })

  test(`${label}: an exact route wins over a prefix that also matches`, async () => {
    await withHarness(create, async ({ service }, port) => {
      service.register({ kind: 'prefix', path: '/api', handler: respond('prefix') })
      service.register({ kind: 'exact', path: '/api/exact', handler: respond('exact') })
      // A guard is likely to treat the two kinds differently — a prefix route
      // serves data, an exact one may serve a document — so which one wins
      // decides which answer an unauthenticated caller receives.
      expect((await get(port, '/api/exact')).body).toBe('exact')
      expect((await get(port, '/api/other')).body).toBe('prefix')
      expect((await get(port, '/api-v2')).status).toBe(404)
    })
  })

  test(`${label}: the longest segment-boundary prefix wins`, async () => {
    await withHarness(create, async ({ service }, port) => {
      service.register({ kind: 'prefix', path: '/api', handler: respond('shallow') })
      service.register({ kind: 'prefix', path: '/api/deep', handler: respond('deep') })
      expect((await get(port, '/api/deep/item')).body).toBe('deep')
      expect((await get(port, '/apix')).status).toBe(404)
    })
  })

  test(`${label}: the fallback fires only when nothing else matched`, async () => {
    await withHarness(create, async ({ service }, port) => {
      service.register({ kind: 'exact', path: '/known', handler: respond('known') })
      const dispose = service.registerFallback(respond('spa'))
      expect(typeof dispose).toBe('function')
      expect((await get(port, '/known')).body).toBe('known')
      expect((await get(port, '/anything/else')).body).toBe('spa')
      dispose()
      expect((await get(port, '/anything/else')).status).toBe(404)
    })
  })

  test(`${label}: an async handler is awaited`, async () => {
    await withHarness(create, async ({ service }, port) => {
      // A login handler awaits its key derivation, so a host that called
      // handlers without awaiting them would close responses mid-flight.
      service.register({
        kind: 'exact',
        path: '/slow',
        handler: async (_req, res) => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('late')
        },
      })
      expect((await get(port, '/slow')).body).toBe('late')
    })
  })

  test(`${label}: a rejected HTTP handler is contained as an empty 400`, async () => {
    await withHarness(create, async ({ service }, port) => {
      service.register({
        kind: 'exact',
        path: '/rejects',
        handler: () => Promise.reject(new Error('not response content')),
      })
      service.register({ kind: 'exact', path: '/healthy', handler: respond('healthy') })
      expect(await get(port, '/rejects')).toEqual({ status: 400, body: '' })
      expect((await get(port, '/healthy')).body).toBe('healthy')
    })
  })

  test(`${label}: upgrades are exact-path, unique, and disposable`, async () => {
    await withHarness(create, async ({ service }, port) => {
      const dispose = service.registerUpgrade({
        path: '/ws',
        handler: (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
          socket.end()
        },
      })
      expect(typeof dispose).toBe('function')
      expect(() => service.registerUpgrade({ path: '/ws', handler: () => undefined })).toThrow(
        /duplicate/,
      )
      expect(await upgrade(port, '/ws')).toMatch(/^HTTP\/1\.1 101 /)
      expect(await upgrade(port, '/ws?room=1')).toMatch(/^HTTP\/1\.1 101 /)
      expect(await upgrade(port, '/ws/room')).toBe('')
      dispose()
      // A rejected upgrade has no ServerResponse, so "nothing registered" shows
      // up as a closed socket rather than a status.
      expect(await upgrade(port, '/ws')).toBe('')
    })
  })

  test(`${label}: sync and async upgrade failures close their sockets`, async () => {
    await withHarness(create, async ({ service }, port) => {
      service.registerUpgrade({
        path: '/throws',
        handler: () => {
          throw new Error('upgrade threw')
        },
      })
      service.registerUpgrade({
        path: '/rejects',
        handler: () => Promise.reject(new Error('upgrade failed')),
      })
      expect(await upgrade(port, '/throws')).toBe('')
      expect(await upgrade(port, '/rejects')).toBe('')
    })
  })
}
