/**
 * GitHub OAuth gate behaviour with a mocked GitHub API.
 *
 * These tests keep the real HTTP/session/cookie path and only replace outbound
 * GitHub HTTPS calls, so enrollment and login fail-closed rules stay honest.
 *
 * @module test/integration/github-oauth
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from '@rstest/core'
import {
  createMockContext,
  createMockWebServer,
  type MockContext,
} from '@seaveyon/dsh-plugin-testkit'
import type { LoginConfig } from '../../src/config.js'
import {
  exchangeCode,
  fetchGitHubUser,
  revokeAccessToken,
} from '../../src/github.js'
import { apply, READY_SERVICE } from '../../src/index.js'
import { hashPassword } from '../../src/verifier.js'

const ENV_NAME = 'DSH_WEB_LOGIN_GH_TEST_HASH'
const CLIENT_ID_ENV = 'DSH_WEB_LOGIN_GH_CLIENT_ID'
const CLIENT_SECRET_ENV = 'DSH_WEB_LOGIN_GH_CLIENT_SECRET'
const PASSWORD = 'correct horse battery staple'
const VERIFIER = hashPassword(PASSWORD)

interface Response {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

function request(port: number, path: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<Response> {
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

interface Fixture {
  ctx: MockContext
  port: number
  authFile: string
  recoveryFile: string
  close: () => Promise<void>
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function fixture(overrides: LoginConfig = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-gh-'))
  tempDirs.push(dir)
  const authFile = join(dir, 'github-users.json')
  const recoveryFile = join(dir, 'recovery.json')
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })

  const prior = {
    hash: process.env[ENV_NAME],
    id: process.env[CLIENT_ID_ENV],
    secret: process.env[CLIENT_SECRET_ENV],
  }
  process.env[ENV_NAME] = VERIFIER
  process.env[CLIENT_ID_ENV] = 'test-client-id'
  process.env[CLIENT_SECRET_ENV] = 'test-client-secret'

  const restoreEnv = (): void => {
    if (prior.hash === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior.hash
    if (prior.id === undefined) delete process.env[CLIENT_ID_ENV]
    else process.env[CLIENT_ID_ENV] = prior.id
    if (prior.secret === undefined) delete process.env[CLIENT_SECRET_ENV]
    else process.env[CLIENT_SECRET_ENV] = prior.secret
  }

  try {
    apply(ctx, {
      passwordHashEnv: ENV_NAME,
      githubEnabled: true,
      publicUrl: 'http://127.0.0.1:9',
      githubClientIdEnv: CLIENT_ID_ENV,
      githubClientSecretEnv: CLIENT_SECRET_ENV,
      authorizationFile: authFile,
      recoveryFile,
      secureCookie: false,
      sessionTtlMs: 60_000,
      maxSessions: 10,
      attemptLimit: 5,
      attemptWindowMs: 60_000,
      blockMs: 60_000,
      maxBodyBytes: 128,
      sweepIntervalMs: 1000,
      ...overrides,
    })
    expect(ctx.get(READY_SERVICE)).toBe(true)

    web.service.register({
      kind: 'exact',
      path: '/exact',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('exact')
      },
    })

    const port = await web.listen()
    return {
      ctx,
      port,
      authFile,
      recoveryFile,
      async close() {
        await ctx.dispose()
        await web.close()
        restoreEnv()
      },
    }
  } catch (error) {
    await ctx.dispose()
    await web.close()
    restoreEnv()
    throw error
  }
}

function setCookie(response: Response): string {
  const value = response.headers['set-cookie']
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

async function passwordBootstrap(port: number): Promise<string> {
  const body = `password=${encodeURIComponent(PASSWORD)}`
  const response = await request(port, '/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  })
  expect(response.status).toBe(303)
  expect(response.headers.location).toBe('/login')
  const cookie = setCookie(response).split(';')[0]
  expect(cookie).toMatch(/^dsh_session=/)
  return cookie ?? ''
}

test('bootstrap shows password login and refuses unauthenticated GitHub login start', async () => {
  const app = await fixture()
  try {
    const page = await request(app.port, '/login')
    expect(page.status).toBe(200)
    expect(page.body).toMatch(/<form method="post" action="\/login">/)
    expect(page.body).toMatch(/Bind your GitHub|access password/i)

    const start = await request(app.port, '/auth/github/login')
    expect(start.status).toBe(302)
    expect(start.headers.location).toBe('/login')
  } finally {
    await app.close()
  }
})

test('password bootstrap cannot unlock protected routes until GitHub enroll completes', async () => {
  const app = await fixture()
  try {
    const cookie = await passwordBootstrap(app.port)
    const guarded = await request(app.port, '/exact', { headers: { cookie } })
    expect(guarded.status).toBe(401)

    const enrollPage = await request(app.port, '/login', { headers: { cookie } })
    expect(enrollPage.status).toBe(200)
    expect(enrollPage.body).toMatch(/action="\/auth\/github\/enroll"/)
  } finally {
    await app.close()
  }
})

test('enroll redirects to GitHub with state and PKCE', async () => {
  const app = await fixture()
  try {
    const cookie = await passwordBootstrap(app.port)
    const enroll = await request(app.port, '/auth/github/enroll', {
      method: 'POST',
      headers: { cookie },
    })
    expect(enroll.status).toBe(302)
    const location = String(enroll.headers.location)
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:9/auth/github/callback',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  } finally {
    await app.close()
  }
})

test('github helpers fail closed on malformed GitHub payloads', async () => {
  await expect(
    exchangeCode({
      code: 'x',
      codeVerifier: 'y',
      redirectUri: 'http://127.0.0.1:9/auth/github/callback',
      credentials: { clientId: 'a', clientSecret: 'b' },
      options: {
        timeoutMs: 1000,
        fetchImpl: async () => new Response('{', { status: 200 }),
      },
    }),
  ).rejects.toMatchObject({ code: 'malformed' })

  await expect(
    fetchGitHubUser('tok', {
      timeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify({ id: 'nope', login: 'x' }), { status: 200 }),
    }),
  ).rejects.toMatchObject({ code: 'missing_user_id' })

  await expect(
    revokeAccessToken('tok', { clientId: 'a', clientSecret: 'b' }, {
      timeoutMs: 1000,
      fetchImpl: async () => new Response('no', { status: 401 }),
    }),
  ).rejects.toMatchObject({ code: 'http_status' })
})

test('callback with a bad state fails closed and creates no authz file', async () => {
  const app = await fixture()
  try {
    const response = await request(
      app.port,
      '/auth/github/callback?code=abc&state=not-a-real-state',
    )
    expect(response.status).toBe(401)
    expect(response.body).toMatch(/expired|try again/i)
    await expect(readFile(app.authFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await app.close()
  }
})
