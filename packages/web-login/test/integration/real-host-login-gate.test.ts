/**
 * A deliberately small test against the actual DSH host, rather than the
 * testkit's compatible mock. Most login-gate behavior belongs in the faster
 * mock suite; this one proves that the seam we decorate is still real.
 */

import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { expect, test } from '@rstest/core'
import { apply, type PluginContext } from '../../src/index.js'
import type { WebServerService } from '../../src/types.js'
import { hashPassword } from '../../src/verifier.js'

const require = createRequire(import.meta.url)
const cordisPackage = '@deepseek-ai/cordis'
const webServerPackage = '@deepseek-ai/dsh-host-webserver'
const hasRealHost = [cordisPackage, webServerPackage].every((name) => {
  try {
    require.resolve(`${name}/package.json`)
    return true
  } catch {
    return false
  }
})

const realHostTest = hasRealHost ? test : test.skip
const HASH_ENV = 'DSH_WEB_LOGIN_REAL_HOST_TEST_HASH'
const PASSWORD = 'correct horse battery staple'

interface Response {
  status: number | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
}

interface RealContext {
  get: <T = unknown>(name: string) => T | undefined
  plugin: (plugin: unknown, config: unknown) => Promise<void>
  fiber: { dispose: () => Promise<void> }
  webServer: WebServerService & { port: number }
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
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
 * The route is deliberately registered after the gate. This is the behavior
 * that a host mock alone cannot prove: DSH must accept the replacement
 * registry member and invoke it for later plugin registrations.
 */
realHostTest('a real DSH host protects routes registered after the login gate', async () => {
  const previousHash = process.env[HASH_ENV]
  process.env[HASH_ENV] = hashPassword(PASSWORD)

  let root: RealContext | undefined
  try {
    const [cordis, webserver] = await Promise.all([import(cordisPackage), import(webServerPackage)])
    const Context = cordis.Context as unknown as new () => RealContext
    const WebServer = (webserver.default ?? webserver.WebServer) as unknown
    root = new Context()
    await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })

    apply(root as unknown as PluginContext, {
      passwordHashEnv: HASH_ENV,
      secureCookie: false,
      persistentSessions: false,
      auditEnabled: false,
      sessionTtlMs: 60_000,
      maxSessions: 10,
    })

    const service = root.get<WebServerService>('webServer')
    if (service === undefined) throw new Error('real DSH host did not provide webServer')
    service.register({
      kind: 'prefix',
      path: '/api',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
    })

    const anonymous = await request(root.webServer.port, '/api/private')
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toBe('{"error":"unauthenticated"}')

    const body = `password=${encodeURIComponent(PASSWORD)}`
    const login = await request(root.webServer.port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    })
    const setCookie = login.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0]
    expect(login.status).toBe(303)
    expect(cookie).toMatch(/^dsh_session=/)

    const authenticated = await request(root.webServer.port, '/api/private', {
      headers: { cookie: cookie ?? '' },
    })
    expect(authenticated.status).toBe(200)
    expect(authenticated.body).toBe('{"ok":true}')
  } finally {
    await root?.fiber.dispose()
    if (previousHash === undefined) delete process.env[HASH_ENV]
    else process.env[HASH_ENV] = previousHash
  }
})
