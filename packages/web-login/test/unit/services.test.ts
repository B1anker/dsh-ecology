/**
 * The service graph: what `createServices` declares, what each recipe builds
 * over the configuration, and what a test can swap without touching `apply`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { FactoryDescriptor, InstantiationService, type ServiceIdentifier } from '@seaveyon/dsh-di'
import { createMockContext, createMockWebServer } from '@seaveyon/dsh-plugin-testkit'
import { resolveConfig } from '../../src/config.js'
import {
  createServices,
  IAttemptLimiter,
  ICallbackGate,
  IKdfGate,
  ILabSessionGate,
  ILoginConfig,
  IOAuthStateStore,
  IPluginContext,
  ISecurityAudit,
  ISessionStore,
  IWebServer,
} from '../../src/services.js'

const LAB_ID = 'lab-20260908T061328Z-b7ba1266'

/** A configuration that touches no file: no session file, no audit. */
function options(overrides: Record<string, unknown> = {}) {
  return resolveConfig({
    persistentSessions: false,
    auditEnabled: false,
    sessionTtlMs: 60_000,
    maxSessions: 3,
    attemptLimit: 2,
    attemptWindowMs: 60_000,
    blockMs: 60_000,
    githubMaxConcurrentCallbacks: 1,
    ...overrides,
  })
}

function boot(overrides: Record<string, unknown> = {}, now = () => 1_000) {
  const web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service })
  const collection = createServices(ctx, options(overrides), { sessionBinding: 'b', env: {}, now })
  return { web, ctx, collection, services: new InstantiationService(collection) }
}

describe('createServices', () => {
  test('declares the host registry, the configuration, and every collaborator as a recipe', () => {
    const { web, ctx, collection } = boot()
    expect(collection.get(IWebServer)).toBe(web.service)
    expect(collection.get(IPluginContext)).toBe(ctx)
    expect(collection.get(ILoginConfig)).toMatchObject({ maxSessions: 3, attemptLimit: 2 })
    const recipes: ServiceIdentifier<unknown>[] = [
      ISessionStore,
      IAttemptLimiter,
      IKdfGate,
      IOAuthStateStore,
      ICallbackGate,
      ILabSessionGate,
    ]
    for (const id of recipes) {
      expect(collection.get(id), String(id)).toBeInstanceOf(FactoryDescriptor)
    }
    // Audit is off in this configuration, so it is not in the graph at all —
    // `apply` asks `has()` rather than resolving an `undefined`.
    expect(collection.has(ISecurityAudit)).toBe(false)
  })

  test('the identifiers carry the Cordis names for host services and a prefix for the rest', () => {
    expect(String(IWebServer)).toBe('webServer')
    expect(String(IPluginContext)).toBe('pluginContext')
    expect(String(ISessionStore)).toBe('webLoginSessions')
    expect(String(ILabSessionGate)).toBe('webLoginLabSession')
  })

  test('refuses a context without the registry, naming it', () => {
    expect(() =>
      createServices(createMockContext({}), options(), { sessionBinding: 'b', env: {} }),
    ).toThrow("Host service 'webServer' is not available on this plugin context")
  })

  test('each recipe is built over the configuration and the shared clock, once', () => {
    let clock = 1_000
    const { services } = boot({}, () => clock)

    const sessions = services.get(ISessionStore)
    expect(services.get(ISessionStore)).toBe(sessions)
    // maxSessions: 3 — the fourth open is refused.
    const principal = { provider: 'password', role: 'member', authzVersion: 0 } as const
    expect(sessions.open(principal)).not.toBeNull()
    expect(sessions.open(principal)).not.toBeNull()
    const third = sessions.open(principal)
    expect(third).not.toBeNull()
    expect(sessions.open(principal)).toBeNull()
    // sessionTtlMs: 60_000, on the injected clock.
    clock += 60_001
    expect(sessions.get(third)).toBeUndefined()

    const limiter = services.get(IAttemptLimiter)
    // attemptLimit: 2 — the second failure blocks.
    expect(limiter.fail('k')).toBe(0)
    expect(limiter.fail('k')).toBeGreaterThan(0)

    const gate = services.get(ICallbackGate)
    // githubMaxConcurrentCallbacks: 1.
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)

    expect(services.get(IKdfGate).active).toBe(0)
    expect(services.get(IOAuthStateStore).size).toBe(0)
    services.dispose()
  })

  test('the audit recipe is present when enabled and reports through the context logger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-login-services-'))
    const auditFile = join(dir, 'audit', 'security.log')
    try {
      const { ctx, collection, services } = boot({ auditEnabled: true, auditFile })
      expect(collection.get(ISecurityAudit)).toBeInstanceOf(FactoryDescriptor)

      const audit = services.get(ISecurityAudit)
      audit.record('login_succeeded', { via: 'test' })
      expect(readFileSync(auditFile, 'utf8')).toContain('"event":"login_succeeded"')

      // An append that fails is reported on the context's logger, not thrown
      // into the request that triggered it.
      rmSync(auditFile)
      mkdirSync(auditFile)
      audit.record('login_failed')
      expect(ctx.logs.warn).toHaveLength(1)
      expect(ctx.logs.warn[0]).toMatch(/^dsh-web-login: could not append security audit: /)
      services.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the lab-session gate consults `connection` per request, through the context', () => {
    const web = createMockWebServer()
    const ctx = createMockContext({ webServer: web.service })
    const env = {
      WORLD_LINE_LAB: LAB_ID,
      WORLD_LINE_SESSION_SECRET: 'a'.repeat(64),
      WORLD_LINE_SESSION_EXPIRES: '601000',
      WORLD_LINE_MANAGER_HOME: '/manager',
      DSH_HOME: `/manager/world-line/labs/${LAB_ID}/home`,
    }
    const services = new InstantiationService(
      createServices(ctx, options(), { sessionBinding: 'b', env, now: () => 1_000 }),
    )
    const gate = services.get(ILabSessionGate)
    const request = {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage

    // No `connection` on the context yet — the service that injects this
    // plugin's ready service has not come up — so nothing is delegated.
    expect(gate(request)).toBe(false)

    // Once it exists, the gate reads it on the next request without rebuilding.
    const rejections: (number | undefined)[] = [undefined, 401]
    ctx.provide('connection', { requestRejection: () => rejections.shift() })
    expect(gate(request)).toBe(true)
    expect(gate(request)).toBe(false)
    services.dispose()
  })

  test('a test swaps one recipe for a double and keeps the rest of the graph', () => {
    const { collection } = boot()
    const store = collection.clone()
    const fake = { revokeAll() {} }
    store.set(ISessionStore, fake as never)
    const services = new InstantiationService(store)
    expect(services.get(ISessionStore)).toBe(fake)
    expect(services.get(IAttemptLimiter).size).toBe(0)
    services.dispose()
  })
})
