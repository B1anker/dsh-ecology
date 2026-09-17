/**
 * The gate's service graph: the host services it takes and the collaborators
 * it builds over the resolved configuration.
 *
 * Every collaborator here is a closure factory (`createSessionStore`,
 * `createAttemptLimiter`, ...) that `apply` used to call inline. They are
 * registered as {@link FactoryDescriptor}s instead, so the graph is declared
 * in one place and read in one place: `apply` resolves what it needs from a
 * container and a test builds the same collection with one entry replaced —
 * a session store on a fake clock, a limiter that never blocks — without
 * re-implementing the composition by hand. The factories themselves are
 * unchanged; the container adds a cache, a disposal, and a name in every
 * error path.
 *
 * What is *not* here: the request handlers. They close over per-boot state
 * (`authDocument`, `lifecycle`) that is rewritten on enrol and recovery, and
 * they are the security boundary; they stay in `index.ts`, where the spec
 * comments sit beside the checks they describe.
 *
 * @module @seaveyon/dsh-web-login/services
 */

import type { IncomingMessage } from 'node:http'
import { createDecorator, FactoryDescriptor, ServiceCollection } from '@seaveyon/dsh-di'
import { registerHostServices } from '@seaveyon/dsh-di/host'
import { type AttemptLimiter, createAttemptLimiter } from './attempt-limiter.js'
import { createSecurityAudit, type SecurityAudit } from './audit.js'
import type { ResolvedConfig } from './config.js'
import { createConcurrencyGate } from './github.js'
import { createKdfGate, type KdfGate } from './kdf-gate.js'
import { createLabSessionGate } from './lab-session.js'
import { createOAuthStateStore, type OAuthStateStore } from './oauth-state.js'
import { createSessionStore, type SessionStore } from './sessions.js'
import type { PluginContext, WebServerService } from './types.js'

/** acquire / release over a fixed number of slots; see `createConcurrencyGate`. */
export type ConcurrencyGate = ReturnType<typeof createConcurrencyGate>
/** Whether a request carries a delegated lab session; see `createLabSessionGate`. */
export type LabSessionGate = (req: IncomingMessage) => boolean

/**
 * The host services, under their Cordis names and this plugin's own contract
 * types (`./types`) rather than the container's minimal ones. The same keys
 * as `@seaveyon/dsh-di/host` exports — `createDecorator` returns one
 * identifier per name.
 */
export const IPluginContext = createDecorator<PluginContext>('pluginContext')
export const IWebServer = createDecorator<WebServerService>('webServer')

/** The validated configuration the whole graph is built over. */
export const ILoginConfig = createDecorator<ResolvedConfig>('webLoginConfig')
export const ISessionStore = createDecorator<SessionStore>('webLoginSessions')
/** Registered only when `auditEnabled`; consumers ask `has()` first. */
export const ISecurityAudit = createDecorator<SecurityAudit>('webLoginAudit')
export const IAttemptLimiter = createDecorator<AttemptLimiter>('webLoginAttemptLimiter')
export const IKdfGate = createDecorator<KdfGate>('webLoginKdfGate')
export const IOAuthStateStore = createDecorator<OAuthStateStore>('webLoginOAuthStates')
export const ICallbackGate = createDecorator<ConcurrencyGate>('webLoginCallbackGate')
export const ILabSessionGate = createDecorator<LabSessionGate>('webLoginLabSession')

/** What the graph needs beyond the context and the configuration. */
export interface ServiceInputs {
  /**
   * Ties persisted sessions to the verifier they were minted under, so a
   * rotated password invalidates the session file. `apply` derives it from
   * the verifier; a test passes any string.
   */
  sessionBinding: string
  /** Read by the lab-session gate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Clock for every collaborator that expires something. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * The collection `apply` builds its container from.
 *
 * `webServer` is required: the gate has nothing to decorate without it, and
 * failing here, with the service named, is better than failing at the first
 * request. The `connection` service is *not* registered, on purpose — it
 * waits for this plugin's ready service at startup, so it can only be looked
 * up per request, which the lab-session gate does through the context.
 */
export function createServices(
  ctx: PluginContext,
  options: ResolvedConfig,
  inputs: ServiceInputs,
): ServiceCollection {
  const now = inputs.now ?? Date.now
  const env = inputs.env ?? process.env

  const collection = registerHostServices(new ServiceCollection(), ctx, { required: [IWebServer] })
  collection.set(ILoginConfig, options)
  collection.set(
    ISessionStore,
    new FactoryDescriptor(() =>
      createSessionStore({
        ttlMs: options.sessionTtlMs,
        maxSessions: options.maxSessions,
        persistentFile: options.persistentSessions ? options.sessionFile : undefined,
        binding: inputs.sessionBinding,
        now,
      }),
    ),
  )
  if (options.auditEnabled) {
    collection.set(
      ISecurityAudit,
      new FactoryDescriptor((accessor) => {
        const logger = accessor.get(IPluginContext).logger
        return createSecurityAudit(options.auditFile, undefined, (error) =>
          logger.warn(
            `dsh-web-login: could not append security audit: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }),
    )
  }
  collection.set(
    IAttemptLimiter,
    new FactoryDescriptor(() =>
      createAttemptLimiter({
        limit: options.attemptLimit,
        windowMs: options.attemptWindowMs,
        blockMs: options.blockMs,
        maxClients: options.maxAttemptClients,
        globalLimit: options.globalAttemptLimit,
        globalBlockMs: options.globalBlockMs,
        now,
      }),
    ),
  )
  collection.set(
    IKdfGate,
    new FactoryDescriptor(() =>
      createKdfGate({ concurrency: options.kdfConcurrency, queueDepth: options.kdfQueueDepth }),
    ),
  )
  collection.set(
    IOAuthStateStore,
    new FactoryDescriptor(() =>
      createOAuthStateStore({
        ttlMs: options.githubStateTtlMs,
        maxPending: options.githubMaxPendingStates,
        now,
      }),
    ),
  )
  collection.set(
    ICallbackGate,
    new FactoryDescriptor(() => createConcurrencyGate(options.githubMaxConcurrentCallbacks)),
  )
  collection.set(
    ILabSessionGate,
    new FactoryDescriptor((accessor) => {
      const context = accessor.get(IPluginContext)
      return createLabSessionGate(env, now, (req) => {
        // Resolved per request: `connection` is not on the context at apply
        // time (it injects this plugin's ready service).
        const connection = context.get<{
          requestRejection?: (request: IncomingMessage) => number | undefined
        }>('connection')
        return (
          typeof connection?.requestRejection === 'function' &&
          connection.requestRejection(req) === undefined
        )
      })
    }),
  )
  return collection
}
