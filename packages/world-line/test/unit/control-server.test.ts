/**
 * The workers' shared loopback control endpoint: bearer auth on every
 * request, the two verbs, and nothing else — exercised over a real socket,
 * which is how the CLI reaches it.
 */

import type { Server } from 'node:http'
import { afterEach, describe, expect, test } from '@rstest/core'
import { createControlServer, listenLoopback } from '../../src/control-server.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function serve(endpoint: Parameters<typeof createControlServer>[0]): Promise<string> {
  const server = createControlServer(endpoint)
  servers.push(server)
  const port = await listenLoopback(server)
  return `http://127.0.0.1:${port}`
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('control server', () => {
  test('refuses every request without the exact bearer token', async () => {
    const base = await serve({
      token: () => 'secret',
      status: () => ({ ok: true }),
      stop: () => {},
    })
    for (const headers of [
      {},
      auth('wrong'),
      { authorization: 'secret' },
      { authorization: 'Basic secret' },
    ]) {
      const response = await fetch(`${base}/status`, { headers })
      expect(response.status, JSON.stringify(headers)).toBe(403)
    }
    const stop = await fetch(`${base}/stop`, { method: 'POST' })
    expect(stop.status).toBe(403)
  })

  test('refuses everything while the token is not minted yet', async () => {
    // The lab supervisor listens before DSH's record exists; a caller in
    // that window is turned away instead of taking the process down.
    let token: string | undefined
    const base = await serve({ token: () => token, status: () => ({ ok: true }), stop: () => {} })
    expect((await fetch(`${base}/status`, { headers: auth('anything') })).status).toBe(403)
    token = 'now'
    const response = await fetch(`${base}/status`, { headers: auth('now') })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('GET /status returns the current status as uncacheable JSON', async () => {
    let running = true
    const base = await serve({
      token: () => 't',
      status: () => ({ running, ready: running ? { slot: 'a' } : null }),
      stop: () => {},
    })
    const first = await fetch(`${base}/status`, { headers: auth('t') })
    expect(first.headers.get('content-type')).toBe('application/json')
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(await first.json()).toEqual({ running: true, ready: { slot: 'a' } })
    running = false
    expect(await (await fetch(`${base}/status`, { headers: auth('t') })).json()).toEqual({
      running: false,
      ready: null,
    })
  })

  test('POST /stop runs the stop and answers with its body, or the status when it has none', async () => {
    const stops: string[] = []
    let stopping = false
    const withBody = await serve({
      token: () => 't',
      status: () => ({ id: 'lab-1' }),
      stop: async () => {
        stops.push('lab')
        return { id: 'lab-1', stopped: true }
      },
    })
    const stopped = await fetch(`${withBody}/stop`, { method: 'POST', headers: auth('t') })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ id: 'lab-1', stopped: true })

    const withoutBody = await serve({
      token: () => 't',
      status: () => ({ running: true, stopping }),
      stop: () => {
        stops.push('deployment')
        stopping = true
      },
    })
    const aborted = await fetch(`${withoutBody}/stop`, { method: 'POST', headers: auth('t') })
    expect(await aborted.json()).toEqual({ running: true, stopping: true })
    expect(stops).toEqual(['lab', 'deployment'])
  })

  test('a stop that throws is a 500, and the server stays up', async () => {
    const base = await serve({
      token: () => 't',
      status: () => ({ ok: true }),
      stop: () => {
        throw new Error('DSH would not exit')
      },
    })
    expect((await fetch(`${base}/stop`, { method: 'POST', headers: auth('t') })).status).toBe(500)
    expect((await fetch(`${base}/status`, { headers: auth('t') })).status).toBe(200)
  })

  test('any other route or method is 404 — including GET /stop and POST /status', async () => {
    const stops: number[] = []
    const base = await serve({
      token: () => 't',
      status: () => ({ ok: true }),
      stop: () => {
        stops.push(1)
      },
    })
    for (const [path, method] of [
      ['/stop', 'GET'],
      ['/status', 'POST'],
      ['/', 'GET'],
      ['/status/extra', 'GET'],
      ['/stop', 'DELETE'],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method, headers: auth('t') })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    expect(stops).toEqual([])
  })

  test('listenLoopback binds an ephemeral loopback port and reports a listen failure', async () => {
    const first = createControlServer({ token: () => 't', status: () => ({}), stop: () => {} })
    servers.push(first)
    const port = await listenLoopback(first)
    expect(port).toBeGreaterThan(0)
    const address = first.address()
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')

    // Force a failure: a server cannot listen twice.
    await expect(listenLoopback(first)).rejects.toThrow(/called more than once/i)
  })
})
