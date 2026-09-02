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
import { mintRecoveryToken, saveRecoveryRecord } from '../../src/authorization.js'
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

/**
 * Install a global fetch mock that answers GitHub token/user/revoke calls.
 * @param user - identity returned by GET /user.
 * @returns a restore function.
 */
function mockGitHubUser(user: { id: number; login: string }): () => void {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'test-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('api.github.com/user')) {
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/applications/') && url.endsWith('/token') && init?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

async function completeOwnerEnroll(
  app: Fixture,
  user: { id: number; login: string } = { id: 4242, login: 'owner' },
): Promise<string> {
  const restoreFetch = mockGitHubUser(user)
  try {
    const cookie = await passwordBootstrap(app.port)
    const enroll = await request(app.port, '/auth/github/enroll', {
      method: 'POST',
      headers: { cookie },
    })
    const location = String(enroll.headers.location)
    const state = new URL(location).searchParams.get('state')
    expect(state).toBeTruthy()

    const callback = await request(
      app.port,
      `/auth/github/callback?code=test-code&state=${encodeURIComponent(state!)}`,
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.location).toBe('/')
    const sessionCookie = setCookie(callback).split(';')[0]
    expect(sessionCookie).toMatch(/^dsh_session=/)

    const stored = JSON.parse(await readFile(app.authFile, 'utf8')) as {
      users: Array<{ githubUserId: number; login: string; role: string }>
    }
    expect(stored.users).toEqual([
      expect.objectContaining({ githubUserId: user.id, login: user.login, role: 'owner' }),
    ])
    return sessionCookie ?? ''
  } finally {
    restoreFetch()
  }
}

test('bootstrap binding and a later GitHub login both admit the same owner', async () => {
  const app = await fixture()
  try {
    const enrolledCookie = await completeOwnerEnroll(app, { id: 7, login: 'octo' })
    const afterEnroll = await request(app.port, '/exact', { headers: { cookie: enrolledCookie } })
    expect(afterEnroll.status).toBe(200)
    expect(afterEnroll.body).toBe('exact')

    // Password login is closed once active.
    const passwordAgain = await request(app.port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(`password=${encodeURIComponent(PASSWORD)}`)),
      },
      body: `password=${encodeURIComponent(PASSWORD)}`,
    })
    expect(passwordAgain.status).toBe(403)
    expect(passwordAgain.body).toMatch(/GitHub/)

    const loginPage = await request(app.port, '/login')
    expect(loginPage.body).toMatch(/Continue with GitHub/)

    const restoreFetch = mockGitHubUser({ id: 7, login: 'octo-renamed' })
    try {
      const start = await request(app.port, '/auth/github/login')
      expect(start.status).toBe(302)
      const state = new URL(String(start.headers.location)).searchParams.get('state')
      const callback = await request(
        app.port,
        `/auth/github/callback?code=second&state=${encodeURIComponent(state!)}`,
      )
      expect(callback.status).toBe(303)
      const cookie = setCookie(callback).split(';')[0] ?? ''
      const exact = await request(app.port, '/exact', { headers: { cookie } })
      expect(exact.status).toBe(200)

      const stored = JSON.parse(await readFile(app.authFile, 'utf8')) as {
        users: Array<{ githubUserId: number; login: string }>
      }
      expect(stored.users[0]?.githubUserId).toBe(7)
      expect(stored.users[0]?.login).toBe('octo-renamed')
    } finally {
      restoreFetch()
    }
  } finally {
    await app.close()
  }
})

test('an unregistered GitHub account is rejected and recovery can rebind the owner', async () => {
  const app = await fixture()
  try {
    await completeOwnerEnroll(app, { id: 11, login: 'owner' })

    const restoreStranger = mockGitHubUser({ id: 99, login: 'stranger' })
    try {
      const start = await request(app.port, '/auth/github/login')
      const state = new URL(String(start.headers.location)).searchParams.get('state')
      const denied = await request(
        app.port,
        `/auth/github/callback?code=nope&state=${encodeURIComponent(state!)}`,
      )
      expect(denied.status).toBe(403)
      expect(denied.body).toMatch(/not allowed/i)
      expect(setCookie(denied)).toBe('')
    } finally {
      restoreStranger()
    }

    const { token, digest } = mintRecoveryToken()
    await saveRecoveryRecord(app.recoveryFile, {
      tokenDigest: digest,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const recovery = await request(app.port, `/auth/recovery?token=${encodeURIComponent(token)}`)
    expect(recovery.status).toBe(303)
    expect(recovery.headers.location).toBe('/login')
    const recoveryCookie = setCookie(recovery).split(';')[0] ?? ''

    // Old owner sessions must be gone after recovery clears authorization.
    const oldOwnerPage = await request(app.port, '/login')
    expect(oldOwnerPage.body).toMatch(/access password|Bind/i)

    const restoreOwner = mockGitHubUser({ id: 77, login: 'new-owner' })
    try {
      const enroll = await request(app.port, '/auth/github/enroll', {
        method: 'POST',
        headers: { cookie: recoveryCookie },
      })
      expect(enroll.status).toBe(302)
      const state = new URL(String(enroll.headers.location)).searchParams.get('state')
      const callback = await request(
        app.port,
        `/auth/github/callback?code=rebind&state=${encodeURIComponent(state!)}`,
      )
      expect(callback.status).toBe(303)
      const cookie = setCookie(callback).split(';')[0] ?? ''
      const exact = await request(app.port, '/exact', { headers: { cookie } })
      expect(exact.status).toBe(200)

      const stored = JSON.parse(await readFile(app.authFile, 'utf8')) as {
        users: Array<{ githubUserId: number }>
      }
      expect(stored.users).toEqual([expect.objectContaining({ githubUserId: 77 })])
    } finally {
      restoreOwner()
    }
  } finally {
    await app.close()
  }
})

test('githubEnabled false keeps the classic password gate', async () => {
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  const prior = process.env[ENV_NAME]
  process.env[ENV_NAME] = VERIFIER
  try {
    apply(ctx, {
      passwordHashEnv: ENV_NAME,
      githubEnabled: false,
      secureCookie: false,
      sessionTtlMs: 60_000,
      maxSessions: 10,
      sweepIntervalMs: 1000,
    })
    web.service.register({
      kind: 'exact',
      path: '/exact',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('exact')
      },
    })
    const port = await web.listen()
    try {
      const page = await request(port, '/login')
      expect(page.body).toMatch(/<form method="post" action="\/login">/)
      expect(page.body.includes('/auth/github/login')).toBe(false)

      const body = `password=${encodeURIComponent(PASSWORD)}`
      const login = await request(port, '/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      })
      expect(login.status).toBe(303)
      expect(login.headers.location).toBe('/')
      const cookie = setCookie(login).split(';')[0] ?? ''
      const exact = await request(port, '/exact', { headers: { cookie } })
      expect(exact.status).toBe(200)

      const missing = await request(port, '/auth/github/login')
      // GitHub routes are not registered when the feature is off.
      expect(missing.status).toBe(404)
      expect(String(missing.headers.location ?? '')).not.toMatch(/github\.com/)
    } finally {
      await ctx.dispose()
      await web.close()
    }
  } finally {
    if (prior === undefined) delete process.env[ENV_NAME]
    else process.env[ENV_NAME] = prior
  }
})
