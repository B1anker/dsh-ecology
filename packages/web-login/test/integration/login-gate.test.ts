import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { expect, test } from '@rstest/core'
import type { LoginConfig } from '../../src/config.js'
import { apply, READY_SERVICE } from '../../src/index.js'
import { hashPassword } from '../../src/verifier.js'
import { createMockContext, createMockWebServer, type MockContext } from '../helpers/mock-server.js'

const ENV_NAME = 'DSH_WEB_LOGIN_TEST_HASH'
const PASSWORD = 'correct horse battery staple'
const VERIFIER = hashPassword(PASSWORD)

/** A response as the tests read it: status, headers, and a decoded body. */
interface Response {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** What {@link request} accepts beyond the path. */
interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * Make an HTTP request without fetch's automatic redirect and header behavior.
 *
 * `fetch` follows redirects and adds headers of its own, which would hide the
 * two things most of these tests are about: the exact status of a redirect, and
 * that a request carrying no `sec-fetch-*` headers is still classified
 * correctly.
 *
 * @param port - the mock server's port.
 * @param path - request target.
 * @param options - `method`, `headers`, and a request `body`.
 * @returns the response status, headers, and body.
 */
function request(port: number, path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Perform a raw upgrade handshake and return the bytes the server wrote.
 *
 * Raw rather than through a WebSocket client because a rejected upgrade has no
 * `ServerResponse`: the plugin writes the 401 status line onto the socket by
 * hand, and that is exactly what has to be asserted.
 *
 * @param port - the mock server's port.
 * @param path - upgrade target.
 * @param headers - extra request headers, such as a session cookie.
 * @returns everything the server sent before closing.
 */
function upgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const supplied = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Connection: Upgrade\r\nUpgrade: websocket\r\n${supplied}\r\n`,
      )
    })
    socket.on('data', (chunk: string) => {
      response += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(response))
  })
}

/** A running gate: its context, its port, and the teardown that stops it. */
interface Fixture {
  ctx: MockContext
  port: number
  close: () => Promise<void>
}

/**
 * Start a decorated gate with representative exact, prefix, fallback, and WS routes.
 * @param overrides - configuration merged over the fixture's own settings.
 * @returns the running fixture.
 */
async function fixture(overrides: LoginConfig = {}): Promise<Fixture> {
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  const prior = process.env[ENV_NAME]
  process.env[ENV_NAME] = VERIFIER

  /** Undo the environment change, whatever happens next. */
  const restoreEnv = (): void => {
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  }

  try {
    apply(ctx, {
      passwordHashEnv: ENV_NAME,
      secureCookie: false,
      sessionTtlMs: 60_000,
      maxSessions: 10,
      attemptLimit: 3,
      attemptWindowMs: 60_000,
      blockMs: 60_000,
      maxBodyBytes: 128,
      sweepIntervalMs: 1000,
      ...overrides,
    })

    expect(ctx.get(READY_SERVICE), 'readiness is published after decoration').toBe(true)

    // These registrations intentionally happen *after* apply, exactly like the
    // dsh route owners that inject dshWebLoginReady.
    web.service.register({
      kind: 'exact',
      path: '/exact',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('exact')
      },
    })
    web.service.register({
      kind: 'prefix',
      path: '/api',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    })
    web.service.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('plugins')
      },
    })
    web.service.registerFallback((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<main>spa</main>')
    })
    web.service.registerUpgrade({
      path: '/ws',
      handler: (_req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        )
        socket.end()
      },
    })

    const port = await web.listen()
    return {
      ctx,
      port,
      async close() {
        ctx.dispose()
        await web.close()
        restoreEnv()
      },
    }
  } catch (error) {
    ctx.dispose()
    await web.close()
    restoreEnv()
    throw error
  }
}

/** A signed-in response, plus the cookie exactly as a browser would send it. */
interface SignIn extends Response {
  cookie: string | undefined
}

/**
 * Log in through the real form endpoint.
 * @param port - the mock server's port.
 * @param password - the password to submit.
 * @returns the response, plus the `name=value` cookie pair to send back.
 */
async function signIn(port: number, password: string = PASSWORD): Promise<SignIn> {
  const body = `password=${encodeURIComponent(password)}`
  const response = await request(port, '/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  })
  const values = response.headers['set-cookie']
  const first = Array.isArray(values) ? values[0] : values
  return { ...response, cookie: first?.split(';')[0] }
}

/**
 * Read the `Set-Cookie` header as a single string.
 *
 * Node types this one header as an array because it is the only one that may
 * legally repeat; every assertion here concerns a single cookie.
 *
 * @param response - the response to read.
 * @returns the first `Set-Cookie` value, or '' when none was sent.
 */
function setCookie(response: Response): string {
  const value = response.headers['set-cookie']
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/**
 * Read a header that must have arrived as a single value.
 * @param response - the response to read.
 * @param name - lower-case header name.
 * @returns the header value, or '' when absent.
 */
function header(response: Response, name: string): string {
  const value = response.headers[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/**
 * Run `body` against a fresh gate, closing it afterwards.
 * @param options - configuration overrides for the fixture.
 * @param body - the test itself.
 */
async function withFixture(
  options: LoginConfig,
  body: (app: Fixture) => Promise<void>,
): Promise<void> {
  const app = await fixture(options)
  try {
    await body(app)
  } finally {
    await app.close()
  }
}

test('anonymous document navigation is redirected to /login', async () => {
  await withFixture({}, async ({ port }) => {
    const response = await request(port, '/', {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/login')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toBe('')
  })
})

test('the anonymous login page is served with its browser hardening headers', async () => {
  await withFixture({}, async ({ port }) => {
    const response = await request(port, '/login', {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    expect(response.status).toBe(200)
    expect(header(response, 'content-type')).toMatch(/^text\/html/)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-frame-options']).toBe('DENY')
    expect(header(response, 'content-security-policy')).toMatch(/default-src 'none'/)
    expect(response.body).toMatch(/<form method="post" action="\/login">/)
  })
})

test('an authenticated visitor is redirected away from /login', async () => {
  await withFixture({}, async ({ port }) => {
    const { cookie = '' } = await signIn(port)
    const response = await request(port, '/login', { headers: { cookie } })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe('/')
  })
})

test('unauthenticated API and plugin requests receive JSON 401, never an HTML redirect', async () => {
  await withFixture({}, async ({ port }) => {
    for (const path of ['/api/status', '/plugins/a.js']) {
      const response = await request(port, path, { headers: { accept: 'text/html,*/*' } })
      expect(response.status, path).toBe(401)
      expect(header(response, 'content-type'), path).toMatch(/^application\/json/)
      expect(response.headers.location, path).toBeUndefined()
      expect(JSON.parse(response.body)).toEqual({ error: 'unauthenticated' })
    }
  })
})

test('unauthenticated raw WebSocket upgrades receive an explanatory 401', async () => {
  await withFixture({}, async ({ port }) => {
    const response = await upgrade(port, '/ws')
    // Dropping the connection instead would leave the client reconnecting
    // forever with no idea why.
    expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized\r?\n/)
    expect(response).toMatch(/Connection: close/i)
    expect(response).toMatch(/Cache-Control: no-store/i)
    expect(response).toMatch(/Content-Length: 0/i)
  })
})

test('a successful login grants access to exact, prefix, fallback, and upgrade routes', async () => {
  await withFixture({}, async ({ port }) => {
    const login = await signIn(port)
    expect(login.status).toBe(303)
    expect(login.headers.location).toBe('/')
    expect(login.cookie).toMatch(/^dsh_session=/)
    expect(setCookie(login)).toMatch(/HttpOnly/)
    expect(setCookie(login)).toMatch(/SameSite=Strict/)
    expect(setCookie(login).includes('Secure'), 'fixture deliberately uses local HTTP').toBe(false)

    const cookie = login.cookie ?? ''

    const exact = await request(port, '/exact', { headers: { cookie } })
    expect(exact.status).toBe(200)
    expect(exact.body).toBe('exact')

    const api = await request(port, '/api/status', { headers: { cookie } })
    expect(api.status).toBe(200)
    expect(api.body).toBe('{"ok":true}')

    const fallback = await request(port, '/any/spa/path', { headers: { cookie } })
    expect(fallback.status).toBe(200)
    expect(fallback.body).toBe('<main>spa</main>')

    const ws = await upgrade(port, '/ws', { cookie })
    expect(ws).toMatch(/^HTTP\/1\.1 101 Switching Protocols\r?\n/)
  })
})

test('a wrong password is denied and is never included in logs or HTML', async () => {
  await withFixture({}, async ({ port, ctx }) => {
    const password = 'definitely-not-the-password'
    const response = await signIn(port, password)
    expect(response.status).toBe(401)
    expect(response.body).toMatch(/Incorrect password/)
    expect(response.body.includes(password)).toBe(false)
    // Startup and failure lines are the most-copied text in any bug report.
    expect(ctx.logs.warn).toHaveLength(1)
    expect(ctx.logs.warn[0]?.includes(password)).toBe(false)
    expect(ctx.logs.warn[0]?.includes(VERIFIER)).toBe(false)
  })
})

test('the third wrong password blocks before a fourth body is processed', async () => {
  await withFixture({}, async ({ port, ctx }) => {
    for (let index = 0; index < 2; index += 1) {
      expect((await signIn(port, 'wrong')).status, `attempt ${index + 1}`).toBe(401)
    }
    const third = await signIn(port, 'wrong')
    expect(third.status).toBe(429)
    expect(third.headers['retry-after']).toBe('60')
    expect(ctx.logs.warn).toHaveLength(3)

    // A blocked client is refused before reading a body and before scrypt. This
    // also proves the limiter response stays a page for a form submission.
    const huge = 'password='.padEnd(10_000, 'x')
    const fourth = await request(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(huge)),
      },
      body: huge,
    })
    expect(fourth.status).toBe(429)
    expect(ctx.logs.warn, 'a blocked attempt costs a map lookup, not a log line').toHaveLength(3)
  })
})

test('a successful login clears prior failures for that client', async () => {
  await withFixture({}, async ({ port }) => {
    expect((await signIn(port, 'wrong')).status).toBe(401)
    expect((await signIn(port, PASSWORD)).status).toBe(303)
    // It is a new failure, not the second failure carried through a success.
    expect((await signIn(port, 'wrong')).status).toBe(401)
  })
})

test('malformed, oversized, and unsupported login bodies receive precise errors', async () => {
  await withFixture({}, async ({ port }) => {
    const get = await request(port, '/logout')
    expect(get.status).toBe(405)
    expect(JSON.parse(get.body)).toEqual({ error: 'method_not_allowed' })
    expect(get.headers.allow).toBe('POST')

    const put = await request(port, '/login', { method: 'PUT' })
    expect(put.status).toBe(405)
    expect(put.headers.allow).toBe('GET, HEAD, POST')

    const json = await request(port, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"x"}',
    })
    expect(json.status).toBe(415)
    expect(JSON.parse(json.body)).toEqual({ error: 'unsupported_media_type' })

    const oversized = await request(port, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '129' },
      body: 'x'.repeat(129),
    })
    expect(oversized.status).toBe(413)
    expect(JSON.parse(oversized.body)).toEqual({ error: 'payload_too_large' })
  })
})

test('logout revokes the server session and clears the browser cookie', async () => {
  await withFixture({}, async ({ port }) => {
    const { cookie = '' } = await signIn(port)
    const logout = await request(port, '/logout', { method: 'POST', headers: { cookie } })
    expect(logout.status).toBe(303)
    expect(logout.headers.location).toBe('/login')
    // A clear that differs in name, path, or attributes leaves the browser's
    // cookie in place, so the operator would appear signed in until it expired.
    expect(setCookie(logout)).toMatch(/^dsh_session=;/)
    expect(setCookie(logout)).toMatch(/Path=\//)
    expect(setCookie(logout)).toMatch(/HttpOnly/)
    expect(setCookie(logout)).toMatch(/SameSite=Strict/)
    expect(setCookie(logout)).toMatch(/Max-Age=0/)

    const after = await request(port, '/exact', { headers: { cookie } })
    expect(after.status, 'the server-side session is gone, not just the cookie').toBe(401)
  })
})

test('startup fails closed when the verifier is absent or malformed', () => {
  const prior = process.env[ENV_NAME]
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  try {
    delete process.env[ENV_NAME]
    // Serving an open port because a variable was unset is the one outcome a
    // login plugin must never produce.
    expect(() => apply(ctx, { passwordHashEnv: ENV_NAME })).toThrow(new RegExp(ENV_NAME))
    expect(web.service.register.name, 'the registry must remain undecorated').toBe('register')

    process.env[ENV_NAME] = 'not-a-verifier'
    expect(() => apply(ctx, { passwordHashEnv: ENV_NAME })).toThrow(new RegExp(ENV_NAME))
    expect(ctx.teardowns, 'no timer or routes should exist after failed validation').toHaveLength(0)
  } finally {
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  }
})

test('disposal does not clobber a decorator installed after the gate', () => {
  const prior = process.env[ENV_NAME]
  process.env[ENV_NAME] = VERIFIER
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  try {
    apply(ctx, { passwordHashEnv: ENV_NAME, secureCookie: false })
    const gateDecorator = web.service.register
    const laterDecorator: typeof gateDecorator = (route) => gateDecorator(route)
    web.service.register = laterDecorator
    ctx.dispose()
    // Blindly restoring the original here would silently remove a later plugin's
    // wrapper too — potentially another security boundary.
    expect(web.service.register).toBe(laterDecorator)
  } finally {
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  }
})
