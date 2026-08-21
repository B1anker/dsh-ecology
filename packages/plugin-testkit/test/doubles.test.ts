import { expect, test } from '@rstest/core'
import { createMockContext } from '../src/context.js'
import { fakeRequest, fakeResponse, fakeStreamingRequest } from '../src/http.js'
import { createMockWebServer } from '../src/web-server.js'

test('the context collects teardowns and runs them in reverse', () => {
  const order: string[] = []
  const ctx = createMockContext({})
  ctx.effect(() => () => order.push('first'), 'first')
  ctx.effect(() => () => order.push('second'), 'second')

  expect(ctx.teardowns.map(({ label }) => label)).toEqual(['first', 'second'])
  ctx.dispose()
  // Cordis unwinds in reverse, so a teardown can assume everything registered
  // after it has already run.
  expect(order).toEqual(['second', 'first'])
})

test('a setup that returns nothing registers no teardown', () => {
  const ctx = createMockContext({})
  ctx.effect(() => undefined, 'no teardown')
  expect(ctx.teardowns).toHaveLength(0)
})

test('the context records logs instead of printing them', () => {
  const ctx = createMockContext({})
  ctx.logger.info('started')
  ctx.logger.warn('something')
  // Readable afterwards because "what did this plugin log on failure?" is a
  // security question in any package that handles credentials.
  expect(ctx.logs).toEqual({ info: ['started'], warn: ['something'] })
})

test('services are readable and writable through the context', () => {
  const services: Record<string, unknown> = { webServer: 'a service' }
  const ctx = createMockContext(services)
  expect(ctx.get('webServer')).toBe('a service')
  expect(ctx.get('absent')).toBeUndefined()
  ctx.set?.('published', true)
  expect(ctx.get('published')).toBe(true)
})

test('the registry refuses duplicate routes, upgrades, and a second fallback', () => {
  const { service } = createMockWebServer()
  const route = { kind: 'exact', path: '/x', handler: () => undefined } as const
  service.register(route)
  // dsh rejects both, and a mock that accepted them would let a plugin pass a
  // test it would fail against the host.
  expect(() => service.register({ ...route })).toThrow(/duplicate/)
  service.registerUpgrade({ path: '/ws', handler: () => undefined })
  expect(() => service.registerUpgrade({ path: '/ws', handler: () => undefined })).toThrow(
    /duplicate/,
  )
  service.registerFallback(() => undefined)
  expect(() => service.registerFallback(() => undefined)).toThrow(/fallback already claimed/)
})

test('the same path under a different kind is not a duplicate', () => {
  const { service } = createMockWebServer()
  service.register({ kind: 'exact', path: '/x', handler: () => undefined })
  expect(() =>
    service.register({ kind: 'prefix', path: '/x', handler: () => undefined }),
  ).not.toThrow()
})

test('stale registry disposers clear whatever now occupies the host key', () => {
  const { service } = createMockWebServer()
  const first = service.register({ kind: 'exact', path: '/x', handler: () => undefined })
  const upgrade = service.registerUpgrade({ path: '/ws', handler: () => undefined })
  const fallback = service.registerFallback(() => undefined)

  first()
  upgrade()
  fallback()

  service.register({ kind: 'exact', path: '/x', handler: () => undefined })
  service.registerUpgrade({ path: '/ws', handler: () => undefined })
  service.registerFallback(() => undefined)

  // The host uses keyed Map.delete operations and an unconditional fallback
  // clear, not identity checks. A stale disposer therefore clears a replacement
  // that reused its key; the test double must expose that surprising behaviour.
  first()
  upgrade()
  fallback()

  expect(() =>
    service.register({ kind: 'exact', path: '/x', handler: () => undefined }),
  ).not.toThrow()
  expect(() => service.registerUpgrade({ path: '/ws', handler: () => undefined })).not.toThrow()
  expect(() => service.registerFallback(() => undefined)).not.toThrow()
})

test('a handler that throws becomes an empty 400 and the server stays healthy', async () => {
  const web = createMockWebServer()
  web.service.register({
    kind: 'exact',
    path: '/boom',
    handler: () => {
      throw new Error('handler exploded')
    },
  })
  web.service.register({
    kind: 'exact',
    path: '/rejects',
    handler: () => Promise.reject('a bare string'),
  })
  web.service.register({
    kind: 'exact',
    path: '/healthy',
    handler: (_req, res) => {
      res.end('ok')
    },
  })
  web.service.register({
    kind: 'exact',
    path: '/after-headers',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-length': '5' })
      res.flushHeaders()
      throw new Error('too late to replace the status')
    },
  })
  const port = await web.listen()
  try {
    const failed = await fetch(`http://127.0.0.1:${port}/boom`)
    expect(failed.status).toBe(400)
    expect(await failed.text()).toBe('')

    // `throw` and a rejected promise are the same event here, and neither is
    // obliged to carry an Error.
    const rejected = await fetch(`http://127.0.0.1:${port}/rejects`)
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('')

    const healthy = await fetch(`http://127.0.0.1:${port}/healthy`)
    expect(await healthy.text()).toBe('ok')

    // Once headers are on the wire, the host cannot replace them with a 400;
    // it terminates the incomplete body instead of leaking an error message.
    const late = await fetch(`http://127.0.0.1:${port}/after-headers`)
    expect(late.status).toBe(200)
    await expect(late.text()).rejects.toThrow()
  } finally {
    await web.close()
  }
})

test('fakeRequest lower-cases header names and can drop its socket', () => {
  const req = fakeRequest({ headers: { 'X-Forwarded-For': '1.1.1.1' }, remoteAddress: '10.0.0.1' })
  expect(req.headers['x-forwarded-for']).toBe('1.1.1.1')
  expect(req.socket.remoteAddress).toBe('10.0.0.1')

  // The shape a request has after the peer has gone: no socket at all, rather
  // than a socket with no address.
  const orphan = fakeRequest({ remoteAddress: null })
  expect(orphan.socket).toBeUndefined()
})

test('fakeStreamingRequest reports a destroy instead of performing one', () => {
  const stream = fakeStreamingRequest()
  expect(stream.destroyed()).toBe(false)
  stream.request.destroy()
  // A real destroy would end the stream and make the question unanswerable
  // afterwards, which is the whole reason this double exists.
  expect(stream.destroyed()).toBe(true)
  stream.push('still writable')
})

test('fakeStreamingRequest delivers a body under the test’s control', async () => {
  const stream = fakeStreamingRequest({ method: 'POST', headers: { 'Content-Length': '9' } })
  expect(stream.request.method).toBe('POST')
  expect(stream.request.headers['content-length']).toBe('9')

  const chunks: string[] = []
  stream.request.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
  const ended = new Promise<void>((resolve) => stream.request.on('end', () => resolve()))

  // Chunk boundaries are the point: a reader that caps a body has to cap it
  // while streaming, and only a body split by hand shows whether it does.
  stream.push('first')
  stream.push('rest')
  expect(stream.listenerCount('data')).toBe(1)
  stream.end()
  await ended

  expect(chunks).toEqual(['first', 'rest'])
})

test('fakeStreamingRequest can signal a client that went away mid-body', async () => {
  const stream = fakeStreamingRequest()
  const aborted = new Promise<void>((resolve) => stream.request.on('aborted', () => resolve()))
  expect(stream.listenerCount('aborted')).toBe(1)

  stream.push('half a ')
  stream.abort()
  await aborted

  // The stream stays open afterwards, so a reader that leaves a listener behind
  // on abort is still observable.
  expect(stream.destroyed()).toBe(false)
})

test('fakeResponse records a status, lower-cased headers, and a body', () => {
  const res = fakeResponse()
  expect(res.headersSent).toBe(false)
  res.writeHead(303, { Location: '/login', 'Set-Cookie': ['a=1', 'b=2'] })
  res.end('done')
  expect(res.status).toBe(303)
  expect(res.headers).toEqual({ location: '/login', 'set-cookie': ['a=1', 'b=2'] })
  expect(res.body).toBe('done')
  expect(res.headersSent).toBe(true)
})

test('fakeResponse records an empty body for a bodyless end', () => {
  const res = fakeResponse()
  res.writeHead(302, {})
  res.end()
  expect(res.body).toBe('')
})
