import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import net from 'node:net'
import { test } from 'node:test'
import { apply, READY_SERVICE } from '../../src/index.js'
import { hashPassword } from '../../src/verifier.js'
import { createMockContext, createMockWebServer } from '../helpers/mock-server.js'

const ENV_NAME = 'DSH_WEB_LOGIN_TEST_HASH'
const PASSWORD = 'correct horse battery staple'
const VERIFIER = hashPassword(PASSWORD)

/** Make an HTTP request without fetch's automatic redirect and header behavior. */
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** A raw upgrade request, because an unauthenticated upgrade has no response object. */
function upgrade(port, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const supplied = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join('')
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${supplied}\r\n`,
      )
    })
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', reject)
    socket.on('end', () => resolve(response))
  })
}

/** Start a decorated gate with representative exact, prefix, fallback, and WS routes. */
async function fixture(overrides = {}) {
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  const prior = process.env[ENV_NAME]
  process.env[ENV_NAME] = VERIFIER

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

    assert.equal(ctx.get(READY_SERVICE), true, 'readiness is published after decoration')

    // These registrations intentionally happen *after* apply, exactly like the
    // dsh route owners that inject dshWebLoginReady.
    web.service.register({
      kind: 'exact', path: '/exact', handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('exact')
      },
    })
    web.service.register({
      kind: 'prefix', path: '/api', handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    })
    web.service.register({
      kind: 'prefix', path: '/plugins', handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('plugins')
      },
    })
    web.service.registerFallback((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<main>spa</main>')
    })
    web.service.registerUpgrade({
      path: '/ws', handler: (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
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
        if (prior === undefined) delete process.env[ENV_NAME]
        else process.env[ENV_NAME] = prior
      },
    }
  } catch (error) {
    ctx.dispose()
    await web.close()
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
    throw error
  }
}

/** Log in and return the cookie exactly as a browser would send it. */
async function signIn(port, password = PASSWORD) {
  const body = `password=${encodeURIComponent(password)}`
  const response = await request(port, '/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  })
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0]
  return { ...response, cookie }
}

async function withFixture(options, body) {
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
    assert.equal(response.status, 302)
    assert.equal(response.headers.location, '/login')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.body, '')
  })
})

test('the anonymous login page is served with its browser hardening headers', async () => {
  await withFixture({}, async ({ port }) => {
    const response = await request(port, '/login', {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /^text\/html/)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-frame-options'], 'DENY')
    assert.match(response.headers['content-security-policy'], /default-src 'none'/)
    assert.match(response.body, /<form method="post" action="\/login">/)
  })
})

test('an authenticated visitor is redirected away from /login', async () => {
  await withFixture({}, async ({ port }) => {
    const { cookie } = await signIn(port)
    const response = await request(port, '/login', { headers: { cookie } })
    assert.equal(response.status, 302)
    assert.equal(response.headers.location, '/')
  })
})

test('unauthenticated API and plugin requests receive JSON 401, never an HTML redirect', async () => {
  await withFixture({}, async ({ port }) => {
    for (const path of ['/api/status', '/plugins/a.js']) {
      const response = await request(port, path, { headers: { accept: 'text/html,*/*' } })
      assert.equal(response.status, 401, path)
      assert.match(response.headers['content-type'], /^application\/json/, path)
      assert.equal(response.headers.location, undefined, path)
      assert.deepEqual(JSON.parse(response.body), { error: 'unauthenticated' })
    }
  })
})

test('unauthenticated raw WebSocket upgrades receive an explanatory 401', async () => {
  await withFixture({}, async ({ port }) => {
    const response = await upgrade(port, '/ws')
    assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r?\n/)
    assert.match(response, /Connection: close/i)
    assert.match(response, /Cache-Control: no-store/i)
    assert.match(response, /Content-Length: 0/i)
  })
})

test('a successful login grants access to exact, prefix, fallback, and upgrade routes', async () => {
  await withFixture({}, async ({ port }) => {
    const login = await signIn(port)
    assert.equal(login.status, 303)
    assert.equal(login.headers.location, '/')
    assert.match(login.cookie, /^dsh_session=/)
    assert.match(login.headers['set-cookie'][0], /HttpOnly/)
    assert.match(login.headers['set-cookie'][0], /SameSite=Strict/)
    assert.ok(!login.headers['set-cookie'][0].includes('Secure'), 'fixture deliberately uses local HTTP')

    const exact = await request(port, '/exact', { headers: { cookie: login.cookie } })
    assert.equal(exact.status, 200)
    assert.equal(exact.body, 'exact')

    const api = await request(port, '/api/status', { headers: { cookie: login.cookie } })
    assert.equal(api.status, 200)
    assert.equal(api.body, '{"ok":true}')

    const fallback = await request(port, '/any/spa/path', { headers: { cookie: login.cookie } })
    assert.equal(fallback.status, 200)
    assert.equal(fallback.body, '<main>spa</main>')

    const ws = await upgrade(port, '/ws', { headers: { cookie: login.cookie } })
    assert.match(ws, /^HTTP\/1\.1 101 Switching Protocols\r?\n/)
  })
})

test('a wrong password is denied and is never included in logs or HTML', async () => {
  await withFixture({}, async ({ port, ctx }) => {
    const password = 'definitely-not-the-password'
    const response = await signIn(port, password)
    assert.equal(response.status, 401)
    assert.match(response.body, /Incorrect password/)
    assert.ok(!response.body.includes(password))
    assert.equal(ctx.logs.warn.length, 1)
    assert.ok(!ctx.logs.warn[0].includes(password))
    assert.ok(!ctx.logs.warn[0].includes(VERIFIER))
  })
})

test('the third wrong password blocks before a fourth body is processed', async () => {
  await withFixture({}, async ({ port, ctx }) => {
    for (let index = 0; index < 2; index += 1) {
      assert.equal((await signIn(port, 'wrong')).status, 401)
    }
    const third = await signIn(port, 'wrong')
    assert.equal(third.status, 429)
    assert.equal(third.headers['retry-after'], '60')
    assert.equal(ctx.logs.warn.length, 3)

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
    assert.equal(fourth.status, 429)
    assert.equal(ctx.logs.warn.length, 3)
  })
})

test('a successful login clears prior failures for that client', async () => {
  await withFixture({}, async ({ port }) => {
    assert.equal((await signIn(port, 'wrong')).status, 401)
    assert.equal((await signIn(port, PASSWORD)).status, 303)
    // It is a new failure, not the second failure carried through a success.
    assert.equal((await signIn(port, 'wrong')).status, 401)
  })
})

test('malformed, oversized, and unsupported login bodies receive precise errors', async () => {
  await withFixture({}, async ({ port }) => {
    const get = await request(port, '/logout')
    assert.equal(get.status, 405)
    assert.deepEqual(JSON.parse(get.body), { error: 'method_not_allowed' })
    assert.equal(get.headers.allow, 'POST')

    const put = await request(port, '/login', { method: 'PUT' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.allow, 'GET, HEAD, POST')

    const json = await request(port, '/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"x"}',
    })
    assert.equal(json.status, 415)
    assert.deepEqual(JSON.parse(json.body), { error: 'unsupported_media_type' })

    const oversized = await request(port, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '129' },
      body: 'x'.repeat(129),
    })
    assert.equal(oversized.status, 413)
    assert.deepEqual(JSON.parse(oversized.body), { error: 'payload_too_large' })
  })
})

test('logout revokes the server session and clears the browser cookie', async () => {
  await withFixture({}, async ({ port }) => {
    const { cookie } = await signIn(port)
    const logout = await request(port, '/logout', { method: 'POST', headers: { cookie } })
    assert.equal(logout.status, 303)
    assert.equal(logout.headers.location, '/login')
    assert.match(logout.headers['set-cookie'][0], /^dsh_session=;/)
    assert.match(logout.headers['set-cookie'][0], /Path=\//)
    assert.match(logout.headers['set-cookie'][0], /HttpOnly/)
    assert.match(logout.headers['set-cookie'][0], /SameSite=Strict/)
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/)

    const after = await request(port, '/exact', { headers: { cookie } })
    assert.equal(after.status, 401)
  })
})

test('startup fails closed when the verifier is absent or malformed', () => {
  const absent = process.env[ENV_NAME]
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  try {
    delete process.env[ENV_NAME]
    assert.throws(() => apply(ctx, { passwordHashEnv: ENV_NAME }), new RegExp(ENV_NAME))
    assert.equal(web.service.register.name, 'register', 'the registry must remain undecorated')

    process.env[ENV_NAME] = 'not-a-verifier'
    assert.throws(() => apply(ctx, { passwordHashEnv: ENV_NAME }), new RegExp(ENV_NAME))
    assert.equal(ctx.teardowns.length, 0, 'no timer or routes should exist after failed validation')
  } finally {
    if (absent === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = absent
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
    const laterDecorator = (route) => gateDecorator(route)
    web.service.register = laterDecorator
    ctx.dispose()
    // Blindly restoring the original here would silently remove a later plugin's
    // wrapper too — potentially another security boundary.
    assert.equal(web.service.register, laterDecorator)
  } finally {
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  }
})
