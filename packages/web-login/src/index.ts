/**
 * dsh-web-login — a cookie-session login gate for the dsh Web surface.
 *
 * The shipped Web composition has no authentication of its own: `dsh web`
 * offers only a browser-trust fence, which defends against DNS rebinding and
 * cross-site reads, not against a stranger who can reach the port. Deployments
 * therefore push credentials into the reverse proxy, where HTTP Basic is the
 * only thing nginx can ask for without extra machinery — and Basic means the
 * browser's native credential dialog, which cannot be styled, cannot log out,
 * and cannot be extended.
 *
 * This plugin moves the gate into the harness so the login surface is an
 * ordinary HTML page:
 *
 *   - Every route registered on `webServer` is wrapped by an authentication
 *     check — `/api`, `/plugins`, the WebSocket upgrades, and the SPA fallback
 *     included. The wrap works by decorating the service's own `register`,
 *     `registerUpgrade`, and `registerFallback`, so a route added by a plugin
 *     loaded later is covered without this plugin knowing its path.
 *   - `GET /login` serves the page, `POST /login` checks the password and mints
 *     a session, `POST /logout` revokes it.
 *   - Optional GitHub OAuth (`githubEnabled`) binds a stable numeric GitHub id
 *     as the authorized owner, then admits only that identity on later visits.
 *   - Sessions are opaque random ids behind an HttpOnly, SameSite=Strict
 *     cookie, held in memory. A restart signs everyone out, which is the right
 *     trade for a single-operator deployment: no key material on disk.
 *
 * Decoration alone is not sufficient, and this is the subtle part. dsh loader
 * entries activate concurrently, so a route owner that registers during the
 * same tick as this plugin could register *before* the decoration is installed
 * and never be guarded. The plugin therefore publishes a `dshWebLoginReady`
 * service only after all three registries are decorated, and route owners are
 * expected to inject it. The package's `cordis.patch.yml` bundle layer applies
 * those dependencies to the shipped Web profile.
 *
 * The password is never stored here or in config. It is read from an
 * environment variable as an scrypt verifier produced by
 * the installed `dsh-web-login-hash` bin, and compared in constant time.
 * GitHub client secrets likewise come only from the environment.
 *
 * @module @seaveyon/dsh-web-login
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAttemptLimiter } from './attempt-limiter.js'
import {
  type AuthLifecycle,
  type AuthorizationDocument,
  clearRecoveryRecord,
  createOwnerDocument,
  digestToken,
  findActiveUser,
  loadAuthStartupState,
  loadRecoveryRecord,
  saveAuthorizationDocument,
  touchLastLogin,
} from './authorization.js'
import { resolveConfig } from './config.js'
import {
  readCookie,
  serializeClearedCookies,
  serializeSessionCookie,
  sessionCookieName,
} from './cookies.js'
import {
  buildAuthorizeUrl,
  createConcurrencyGate,
  exchangeCode,
  fetchGitHubUser,
  type GitHubAppCredentials,
  GitHubRequestError,
  revokeAccessToken,
} from './github.js'
import {
  clientKey,
  isDocumentNavigation,
  isFormPost,
  readBody,
  sendHtml,
  sendJsonError,
  sendRedirect,
} from './http.js'
import { createKdfGate } from './kdf-gate.js'
import { createOAuthStateStore } from './oauth-state.js'
import { type LoginPageMode, renderLoginPage } from './page.js'
import { createSessionStore, PASSWORD_PRINCIPAL, type SessionPrincipal } from './sessions.js'
import type { PluginContext, RouteHandler, WebServerService } from './types.js'
import { requireVerifier, verifyPassword } from './verifier.js'

export type { LoginConfig, ResolvedConfig } from './config.js'
export type { PluginContext, WebServerService } from './types.js'

/** Stable Cordis plugin name; labels the row in diagnostics. */
export const name = 'dsh-web-login'

/** The gate can only wrap routes once the carrier service exists. */
export const inject = ['webServer']

/**
 * Service published once the registries are decorated.
 *
 * Route owners inject this to guarantee their routes are registered through the
 * guard rather than beside it.
 */
export const READY_SERVICE = 'dshWebLoginReady'

/** Paths the gate owns, which must stay reachable while signed out. */
const LOGIN_PATH = '/login'
const LOGOUT_PATH = '/logout'
const GITHUB_LOGIN_PATH = '/auth/github/login'
const GITHUB_CALLBACK_PATH = '/auth/github/callback'
const GITHUB_ENROLL_PATH = '/auth/github/enroll'
const GITHUB_INVITATION_PATH = '/auth/github/invitation'
const RECOVERY_PATH = '/auth/recovery'

/** Exact anonymous paths the gate may leave unguarded. */
const ANON_EXACT_PATHS = new Set([
  LOGIN_PATH,
  LOGOUT_PATH,
  GITHUB_LOGIN_PATH,
  GITHUB_CALLBACK_PATH,
  GITHUB_INVITATION_PATH,
  RECOVERY_PATH,
])

/** Where a successful sign-in lands. Fixed, so there is no redirect parameter to poison. */
const HOME_PATH = '/'

/** User-visible OAuth messages. Stable wording from the security spec. */
const MSG = Object.freeze({
  cancelled: 'GitHub sign-in was cancelled.',
  expired: 'This sign-in request expired. Please try again.',
  notAllowed: 'This GitHub account is not allowed.',
  unavailable: 'GitHub sign-in is temporarily unavailable.',
  maintenance: 'Sign-in is temporarily unavailable. Contact the host administrator.',
  enrollNeeded: 'Sign in with the access password, then bind your GitHub account.',
})

/**
 * Mount the login gate.
 * @param ctx - plugin context carrying the `webServer` service.
 * @param config - plugin configuration from the dsh profile.
 */
export function apply(ctx: PluginContext, config?: unknown): void {
  // Validate before anything observable happens. A bad config or a missing
  // verifier must stop startup while the surface is still unreachable —
  // serving an open port because a variable was unset is the one outcome a
  // login plugin must never produce.
  const options = resolveConfig(config)
  const verifier = requireVerifier(process.env[options.passwordHashEnv], options.passwordHashEnv)

  let githubCredentials: GitHubAppCredentials | undefined
  if (options.githubEnabled) {
    const clientId = process.env[options.githubClientIdEnv]
    const clientSecret = process.env[options.githubClientSecretEnv]
    if (typeof clientId !== 'string' || clientId === '') {
      throw new Error(
        `dsh-web-login: ${options.githubClientIdEnv} must be set when githubEnabled is true`,
      )
    }
    if (typeof clientSecret !== 'string' || clientSecret === '') {
      throw new Error(
        `dsh-web-login: ${options.githubClientSecretEnv} must be set when githubEnabled is true`,
      )
    }
    githubCredentials = { clientId, clientSecret }
  }

  const server = ctx.get<WebServerService>('webServer')
  if (server === undefined) throw new Error('dsh-web-login: webServer service missing')

  const sessions = createSessionStore({
    ttlMs: options.sessionTtlMs,
    maxSessions: options.maxSessions,
  })
  const limiter = createAttemptLimiter({
    limit: options.attemptLimit,
    windowMs: options.attemptWindowMs,
    blockMs: options.blockMs,
    maxClients: options.maxAttemptClients,
    globalLimit: options.globalAttemptLimit,
    globalBlockMs: options.globalBlockMs,
  })
  const kdf = createKdfGate({
    concurrency: options.kdfConcurrency,
    queueDepth: options.kdfQueueDepth,
  })
  const oauthStates = createOAuthStateStore({
    ttlMs: options.githubStateTtlMs,
    maxPending: options.githubMaxPendingStates,
  })
  const callbackGate = createConcurrencyGate(options.githubMaxConcurrentCallbacks)

  const cookieName = sessionCookieName(options.secureCookie)
  const redirectUri = options.githubEnabled ? `${options.publicUrl}${GITHUB_CALLBACK_PATH}` : ''

  /** Mutable authorization snapshot; rewritten after enroll / login touch. */
  let authDocument: AuthorizationDocument | null = null
  let lifecycle: AuthLifecycle = 'active'
  let authLoadError: string | undefined

  if (options.githubEnabled) {
    const startup = loadAuthStartupState(options.authorizationFile, options.recoveryFile)
    authDocument = startup.document
    lifecycle = startup.lifecycle
    authLoadError = startup.error
  }

  /**
   * Current page mode for unauthenticated visitors.
   */
  const pageModeForAnonymous = (): LoginPageMode => {
    if (!options.githubEnabled) return 'password'
    if (lifecycle === 'invalid') return 'maintenance'
    if (lifecycle === 'bootstrap') return 'password'
    return 'github'
  }

  /**
   * Whether a request carries a live, still-authorized session cookie.
   */
  const readPrincipal = (req: IncomingMessage): SessionPrincipal | undefined => {
    const record = sessions.get(readCookie(req.headers.cookie, cookieName))
    if (record === undefined) return undefined
    if (!options.githubEnabled) return record.principal
    const principal = record.principal
    if (principal.provider === 'password-bootstrap' || principal.provider === 'recovery') {
      // Bootstrap/recovery sessions are only useful before an owner exists, or
      // during an open recovery window. They never unlock the full surface alone
      // once GitHub is the daily path — but they *do* unlock enroll.
      if (lifecycle === 'invalid') return undefined
      return principal
    }
    if (principal.provider !== 'github' || principal.githubUserId === undefined) return undefined
    if (authDocument === null) return undefined
    if (principal.authzVersion !== authDocument.authzVersion) return undefined
    const user = findActiveUser(authDocument, principal.githubUserId)
    if (user === undefined) return undefined
    return principal
  }

  const isAuthenticated = (req: IncomingMessage): boolean => {
    const principal = readPrincipal(req)
    if (principal === undefined) return false
    // Bootstrap/recovery principals may reach enroll and the login page, but
    // must not unlock the rest of DSH until a GitHub owner session exists.
    if (
      options.githubEnabled &&
      (principal.provider === 'password-bootstrap' || principal.provider === 'recovery')
    ) {
      return false
    }
    return true
  }

  const isBootstrapSession = (req: IncomingMessage): boolean => {
    const principal = readPrincipal(req)
    return (
      principal !== undefined &&
      (principal.provider === 'password-bootstrap' || principal.provider === 'recovery')
    )
  }

  /**
   * Issue a session cookie and redirect home.
   */
  const admit = (
    res: ServerResponse,
    principal: SessionPrincipal,
    priorSessionId?: string,
  ): boolean => {
    const id = sessions.open(principal)
    if (id === null) return false
    if (priorSessionId !== undefined) sessions.revoke(priorSessionId)
    sendRedirect(res, 303, HOME_PATH, {
      'set-cookie': serializeSessionCookie(id, {
        maxAgeSeconds: options.sessionTtlMs / 1000,
        secure: options.secureCookie,
      }),
    })
    return true
  }

  // ── the gate ───────────────────────────────────────────────────────────────

  const guard = (
    handler: RouteHandler,
    { redirectNavigation = true }: { redirectNavigation?: boolean } = {},
  ): RouteHandler => {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (isAuthenticated(req)) {
        await handler(req, res)
        return
      }
      if (redirectNavigation && isDocumentNavigation(req)) {
        sendRedirect(res, 302, LOGIN_PATH)
        return
      }
      sendJsonError(res, 401, 'unauthenticated')
    }
  }

  const priorRegister = server.register
  const priorRegisterUpgrade = server.registerUpgrade
  const priorRegisterFallback = server.registerFallback

  const originalRegister = priorRegister.bind(server)
  const originalRegisterUpgrade = priorRegisterUpgrade.bind(server)
  const originalRegisterFallback = priorRegisterFallback.bind(server)

  const decoratedRegister: WebServerService['register'] = (route) => {
    if (route.kind === 'exact' && ANON_EXACT_PATHS.has(route.path)) {
      return originalRegister(route)
    }
    // Enroll requires a bootstrap session, not a full gate pass — register it
    // unguarded and enforce bootstrap inside the handler.
    if (route.kind === 'exact' && route.path === GITHUB_ENROLL_PATH) {
      return originalRegister(route)
    }
    return originalRegister({
      ...route,
      handler: guard(route.handler, { redirectNavigation: route.kind !== 'prefix' }),
    })
  }

  const decoratedRegisterUpgrade: WebServerService['registerUpgrade'] = (route) =>
    originalRegisterUpgrade({
      ...route,
      handler: (req, socket, head) => {
        if (!isAuthenticated(req)) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\n' +
              'Connection: close\r\n' +
              'Cache-Control: no-store\r\n' +
              'Content-Length: 0\r\n\r\n',
          )
          socket.end()
          return undefined
        }
        return route.handler(req, socket, head)
      },
    })

  const decoratedRegisterFallback: WebServerService['registerFallback'] = (handler) =>
    originalRegisterFallback(guard(handler))

  // Cordis exposes service members through a function proxy. Reading a member
  // after assigning it therefore returns a proxy around our wrapper, not the
  // wrapper by reference. A marker survives that proxy boundary, while strict
  // identity does not; it lets us still fail closed when a host ignores an
  // assignment and avoid removing a decorator installed after ours on dispose.
  const decorationMarker = Symbol('dsh-web-login registry decoration')
  const mark = <T extends Function>(wrapper: T): T => {
    Object.defineProperty(wrapper, decorationMarker, { value: wrapper })
    return wrapper
  }
  const isCurrentWrapper = (candidate: unknown, wrapper: Function): boolean =>
    typeof candidate === 'function' &&
    (candidate as unknown as Record<symbol, unknown>)[decorationMarker] === wrapper

  mark(decoratedRegister)
  mark(decoratedRegisterUpgrade)
  mark(decoratedRegisterFallback)

  const undecorate = (): void => {
    try {
      server.register = priorRegister
      server.registerUpgrade = priorRegisterUpgrade
      server.registerFallback = priorRegisterFallback
    } catch {
      /* the throw below is the message worth keeping */
    }
  }

  const install = <K extends 'register' | 'registerUpgrade' | 'registerFallback'>(
    member: K,
    wrapper: WebServerService[K],
  ): void => {
    try {
      server[member] = wrapper
    } catch {
      /* reported below, together with the silent case */
    }
    if (isCurrentWrapper(server[member], wrapper)) return
    undecorate()
    throw new Error(
      `dsh-web-login: webServer.${member} could not be wrapped — the host does not ` +
        'expose it as a replaceable property, so the gate cannot guard the routes ' +
        'registered through it. Refusing to start rather than leave the surface open.',
    )
  }

  install('register', decoratedRegister)
  install('registerUpgrade', decoratedRegisterUpgrade)
  install('registerFallback', decoratedRegisterFallback)

  ctx.effect(
    () => () => {
      if (isCurrentWrapper(server.register, decoratedRegister)) server.register = priorRegister
      if (isCurrentWrapper(server.registerUpgrade, decoratedRegisterUpgrade)) {
        server.registerUpgrade = priorRegisterUpgrade
      }
      if (isCurrentWrapper(server.registerFallback, decoratedRegisterFallback)) {
        server.registerFallback = priorRegisterFallback
      }
    },
    'dsh-web-login: registry decoration',
  )

  const sweepTimer = setInterval(() => {
    sessions.sweep()
    limiter.sweep()
    oauthStates.sweep()
  }, options.sweepIntervalMs)
  sweepTimer.unref?.()
  ctx.effect(() => () => clearInterval(sweepTimer), 'dsh-web-login: expiry sweep')

  /**
   * Begin a GitHub OAuth redirect for a given intent.
   */
  const beginOAuth = (
    res: ServerResponse,
    input: {
      intent: 'login' | 'enroll-owner'
      initiatorSessionId?: string
      mode: LoginPageMode
    },
  ): void => {
    if (!options.githubEnabled || githubCredentials === undefined) {
      sendHtml(
        res,
        503,
        renderLoginPage({ title: options.title, mode: 'maintenance', message: MSG.unavailable }),
      )
      return
    }
    const opened = oauthStates.open({
      intent: input.intent,
      initiatorSessionId: input.initiatorSessionId,
    })
    if (opened === null) {
      sendHtml(
        res,
        503,
        renderLoginPage({
          title: options.title,
          mode: input.mode,
          message: MSG.unavailable,
        }),
        { 'retry-after': '30' },
      )
      return
    }
    const location = buildAuthorizeUrl({
      clientId: githubCredentials.clientId,
      redirectUri,
      state: opened.state,
      codeChallenge: opened.codeChallenge,
    })
    sendRedirect(res, 302, location)
  }

  // ── the login surface ──────────────────────────────────────────────────────

  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: LOGIN_PATH,
        handler: async (req, res) => {
          if (req.method === 'GET' || req.method === 'HEAD') {
            if (isAuthenticated(req)) {
              sendRedirect(res, 302, HOME_PATH)
              return
            }
            if (options.githubEnabled && isBootstrapSession(req)) {
              sendHtml(res, 200, renderLoginPage({ title: options.title, mode: 'enroll' }))
              return
            }
            const mode = pageModeForAnonymous()
            const message =
              mode === 'maintenance'
                ? MSG.maintenance
                : mode === 'password' && options.githubEnabled
                  ? MSG.enrollNeeded
                  : ''
            sendHtml(res, 200, renderLoginPage({ title: options.title, mode, message }))
            return
          }
          if (req.method !== 'POST') {
            sendJsonError(res, 405, 'method_not_allowed', { allow: 'GET, HEAD, POST' })
            return
          }

          // Active GitHub mode refuses network password login.
          if (options.githubEnabled && lifecycle !== 'bootstrap') {
            sendHtml(
              res,
              403,
              renderLoginPage({
                title: options.title,
                mode: pageModeForAnonymous(),
                message:
                  lifecycle === 'invalid'
                    ? MSG.maintenance
                    : 'Password sign-in is disabled. Use GitHub.',
              }),
            )
            return
          }

          const key = clientKey(req, options)
          const blockedFor = limiter.retryAfterMs(key)
          if (blockedFor > 0) {
            const seconds = Math.ceil(blockedFor / 1000)
            sendHtml(
              res,
              429,
              renderLoginPage({
                title: options.title,
                mode: 'password',
                message: `Too many failed attempts. Try again in ${seconds} second(s).`,
              }),
              { 'retry-after': String(seconds) },
            )
            return
          }

          if (!isFormPost(req)) {
            sendJsonError(res, 415, 'unsupported_media_type')
            return
          }

          const body = await readBody(req, options.maxBodyBytes)
          if (body === null) {
            sendJsonError(res, 413, 'payload_too_large')
            return
          }

          const password = new URLSearchParams(body).get('password') ?? ''
          const matched = await kdf.run(() => verifyPassword(password, verifier))
          if (matched === null) {
            ctx.logger.warn('dsh-web-login: sign-in queue full; refusing to start another hash')
            sendHtml(
              res,
              503,
              renderLoginPage({
                title: options.title,
                mode: 'password',
                message: 'The server is busy verifying sign-ins. Try again in a moment.',
              }),
              { 'retry-after': '5' },
            )
            return
          }

          if (!matched) {
            const waitMs = limiter.fail(key)
            ctx.logger.warn(`dsh-web-login: failed attempt from ${key}`)
            if (waitMs > 0) {
              const seconds = Math.ceil(waitMs / 1000)
              sendHtml(
                res,
                429,
                renderLoginPage({
                  title: options.title,
                  mode: 'password',
                  message: `Too many failed attempts. Try again in ${seconds} second(s).`,
                }),
                { 'retry-after': String(seconds) },
              )
              return
            }
            sendHtml(
              res,
              401,
              renderLoginPage({
                title: options.title,
                mode: 'password',
                message: 'Incorrect password. Please try again.',
              }),
            )
            return
          }

          const principal: SessionPrincipal = options.githubEnabled
            ? { provider: 'password-bootstrap', role: 'owner', authzVersion: 0 }
            : PASSWORD_PRINCIPAL
          const id = sessions.open(principal)
          if (id === null) {
            ctx.logger.warn('dsh-web-login: session capacity reached; refusing new sign-in')
            sendHtml(
              res,
              503,
              renderLoginPage({
                title: options.title,
                mode: 'password',
                message: 'Too many active sessions. Try again later.',
              }),
              { 'retry-after': '60' },
            )
            return
          }

          limiter.succeed(key)
          if (options.githubEnabled) {
            // Land on the enroll affordance rather than the guarded home.
            sendRedirect(res, 303, LOGIN_PATH, {
              'set-cookie': serializeSessionCookie(id, {
                maxAgeSeconds: options.sessionTtlMs / 1000,
                secure: options.secureCookie,
              }),
            })
            return
          }
          sendRedirect(res, 303, HOME_PATH, {
            'set-cookie': serializeSessionCookie(id, {
              maxAgeSeconds: options.sessionTtlMs / 1000,
              secure: options.secureCookie,
            }),
          })
        },
      }),
    'dsh-web-login: /login route',
  )

  ctx.effect(
    () =>
      server.register({
        kind: 'exact',
        path: LOGOUT_PATH,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJsonError(res, 405, 'method_not_allowed', { allow: 'POST' })
            return
          }
          sessions.revoke(readCookie(req.headers.cookie, cookieName))
          sendRedirect(res, 303, LOGIN_PATH, {
            'set-cookie': serializeClearedCookies({ secure: options.secureCookie }),
          })
        },
      }),
    'dsh-web-login: /logout route',
  )

  if (options.githubEnabled && githubCredentials !== undefined) {
    const credentials = githubCredentials

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: GITHUB_LOGIN_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJsonError(res, 405, 'method_not_allowed', { allow: 'GET, HEAD' })
              return
            }
            if (lifecycle === 'invalid') {
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: 'maintenance',
                  message: MSG.maintenance,
                }),
              )
              return
            }
            if (lifecycle === 'bootstrap') {
              sendRedirect(res, 302, LOGIN_PATH)
              return
            }
            beginOAuth(res, { intent: 'login', mode: 'github' })
          },
        }),
      'dsh-web-login: /auth/github/login',
    )

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: GITHUB_ENROLL_PATH,
          handler: (req, res) => {
            if (req.method !== 'POST') {
              sendJsonError(res, 405, 'method_not_allowed', { allow: 'POST' })
              return
            }
            if (lifecycle !== 'bootstrap' && lifecycle !== 'recovery') {
              sendHtml(
                res,
                403,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: 'Owner binding is not available in the current state.',
                }),
              )
              return
            }
            const sessionId = readCookie(req.headers.cookie, cookieName)
            const record = sessions.get(sessionId)
            if (
              record === undefined ||
              (record.principal.provider !== 'password-bootstrap' &&
                record.principal.provider !== 'recovery')
            ) {
              sendHtml(
                res,
                401,
                renderLoginPage({
                  title: options.title,
                  mode: 'password',
                  message: MSG.enrollNeeded,
                }),
              )
              return
            }
            beginOAuth(res, {
              intent: 'enroll-owner',
              initiatorSessionId: typeof sessionId === 'string' ? sessionId : undefined,
              mode: 'enroll',
            })
          },
        }),
      'dsh-web-login: /auth/github/enroll',
    )

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: GITHUB_CALLBACK_PATH,
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJsonError(res, 405, 'method_not_allowed', { allow: 'GET, HEAD' })
              return
            }

            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const error = url.searchParams.get('error')
            if (error !== null) {
              // Consume state if present so it cannot be replayed later.
              oauthStates.consume(url.searchParams.get('state'))
              sendHtml(
                res,
                401,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.cancelled,
                }),
              )
              return
            }

            const state = url.searchParams.get('state')
            const code = url.searchParams.get('code')
            const pending = oauthStates.consume(state)
            if (pending === undefined || typeof code !== 'string' || code === '') {
              sendHtml(
                res,
                401,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.expired,
                }),
              )
              return
            }

            if (!callbackGate.tryAcquire()) {
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.unavailable,
                }),
                { 'retry-after': '5' },
              )
              return
            }

            let accessToken: string | undefined
            try {
              accessToken = await exchangeCode({
                code,
                codeVerifier: pending.codeVerifier,
                redirectUri,
                credentials,
                options: { timeoutMs: options.githubRequestTimeoutMs },
              })
              const user = await fetchGitHubUser(accessToken, {
                timeoutMs: options.githubRequestTimeoutMs,
              })
              await revokeAccessToken(accessToken, credentials, {
                timeoutMs: options.githubRequestTimeoutMs,
              })
              accessToken = undefined

              if (pending.intent === 'enroll-owner') {
                if (lifecycle !== 'bootstrap' && lifecycle !== 'recovery') {
                  sendHtml(
                    res,
                    403,
                    renderLoginPage({
                      title: options.title,
                      mode: pageModeForAnonymous(),
                      message: 'Owner binding is not available in the current state.',
                    }),
                  )
                  return
                }
                if (pending.initiatorSessionId !== undefined) {
                  const initiator = sessions.get(pending.initiatorSessionId)
                  if (
                    initiator === undefined ||
                    (initiator.principal.provider !== 'password-bootstrap' &&
                      initiator.principal.provider !== 'recovery')
                  ) {
                    sendHtml(
                      res,
                      401,
                      renderLoginPage({
                        title: options.title,
                        mode: 'password',
                        message: MSG.expired,
                      }),
                    )
                    return
                  }
                }

                const document = createOwnerDocument({
                  githubUserId: user.id,
                  login: user.login,
                })
                try {
                  await saveAuthorizationDocument(options.authorizationFile, document)
                } catch (saveError) {
                  ctx.logger.warn(
                    `dsh-web-login: failed to persist owner binding: ${
                      saveError instanceof Error ? saveError.message : 'unknown error'
                    }`,
                  )
                  sendHtml(
                    res,
                    503,
                    renderLoginPage({
                      title: options.title,
                      mode: 'enroll',
                      message: MSG.unavailable,
                    }),
                  )
                  return
                }
                authDocument = document
                lifecycle = 'active'
                sessions.revokeAll()
                await clearRecoveryRecord(options.recoveryFile).catch(() => undefined)
                ctx.logger.info(`dsh-web-login: enrolled GitHub owner id=${user.id}`)
                const admitted = admit(res, {
                  provider: 'github',
                  githubUserId: user.id,
                  githubLogin: user.login,
                  role: 'owner',
                  authzVersion: document.authzVersion,
                })
                if (!admitted) {
                  sendHtml(
                    res,
                    503,
                    renderLoginPage({
                      title: options.title,
                      mode: 'github',
                      message: 'Too many active sessions. Try again later.',
                    }),
                    { 'retry-after': '60' },
                  )
                }
                return
              }

              // Daily login.
              if (authDocument === null || lifecycle === 'invalid') {
                sendHtml(
                  res,
                  503,
                  renderLoginPage({
                    title: options.title,
                    mode: 'maintenance',
                    message: MSG.maintenance,
                  }),
                )
                return
              }
              const authorized = findActiveUser(authDocument, user.id)
              if (authorized === undefined) {
                ctx.logger.warn(`dsh-web-login: rejected GitHub id=${user.id}`)
                sendHtml(
                  res,
                  403,
                  renderLoginPage({
                    title: options.title,
                    mode: 'github',
                    message: MSG.notAllowed,
                  }),
                )
                return
              }

              const touched = touchLastLogin(authDocument, user.id)
              // Best-effort login stamp; failure must not block admission.
              await saveAuthorizationDocument(options.authorizationFile, {
                ...touched,
                users: touched.users.map((entry) =>
                  entry.githubUserId === user.id ? { ...entry, login: user.login } : entry,
                ),
              }).catch(() => undefined)
              authDocument = {
                ...touched,
                users: touched.users.map((entry) =>
                  entry.githubUserId === user.id ? { ...entry, login: user.login } : entry,
                ),
              }

              ctx.logger.info(`dsh-web-login: GitHub login id=${user.id}`)
              const admitted = admit(res, {
                provider: 'github',
                githubUserId: user.id,
                githubLogin: user.login,
                role: authorized.role,
                authzVersion: authDocument.authzVersion,
              })
              if (!admitted) {
                sendHtml(
                  res,
                  503,
                  renderLoginPage({
                    title: options.title,
                    mode: 'github',
                    message: 'Too many active sessions. Try again later.',
                  }),
                  { 'retry-after': '60' },
                )
              }
            } catch (callbackError) {
              const codeName =
                callbackError instanceof GitHubRequestError ? callbackError.code : 'unavailable'
              ctx.logger.warn(`dsh-web-login: GitHub callback failed (${codeName})`)
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.unavailable,
                }),
              )
            } finally {
              accessToken = undefined
              callbackGate.release()
            }
          },
        }),
      'dsh-web-login: /auth/github/callback',
    )

    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: RECOVERY_PATH,
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJsonError(res, 405, 'method_not_allowed', { allow: 'GET, HEAD' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const token = url.searchParams.get('token')
            if (typeof token !== 'string' || token === '') {
              sendHtml(
                res,
                401,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.expired,
                }),
              )
              return
            }
            let record
            try {
              record = await loadRecoveryRecord(options.recoveryFile)
            } catch {
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: 'maintenance',
                  message: MSG.maintenance,
                }),
              )
              return
            }
            if (record === null || record.tokenDigest !== digestToken(token)) {
              sendHtml(
                res,
                401,
                renderLoginPage({
                  title: options.title,
                  mode: pageModeForAnonymous(),
                  message: MSG.expired,
                }),
              )
              return
            }
            // Consume immediately: single-use.
            await clearRecoveryRecord(options.recoveryFile)
            // Clear owners so re-bind is required; keep file invalid-safe by
            // writing an empty-users bootstrap document only after successful
            // recovery session mint would be wrong — spec says recovery opens
            // a short window to re-bind owner. Empty the users list.
            const cleared: AuthorizationDocument = {
              schemaVersion: 1,
              authzVersion: (authDocument?.authzVersion ?? 0) + 1,
              users: [],
            }
            try {
              await saveAuthorizationDocument(options.authorizationFile, cleared)
            } catch {
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: 'maintenance',
                  message: MSG.maintenance,
                }),
              )
              return
            }
            authDocument = cleared
            lifecycle = 'bootstrap'
            sessions.revokeAll()
            const id = sessions.open({
              provider: 'recovery',
              role: 'owner',
              authzVersion: cleared.authzVersion,
            })
            if (id === null) {
              sendHtml(
                res,
                503,
                renderLoginPage({
                  title: options.title,
                  mode: 'password',
                  message: MSG.unavailable,
                }),
              )
              return
            }
            ctx.logger.info('dsh-web-login: recovery session opened')
            sendRedirect(res, 303, LOGIN_PATH, {
              'set-cookie': serializeSessionCookie(id, {
                maxAgeSeconds: options.sessionTtlMs / 1000,
                secure: options.secureCookie,
              }),
            })
          },
        }),
      'dsh-web-login: /auth/recovery',
    )

    // Phase-2 invitation path is reserved anonymously but answers 501 for now.
    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: GITHUB_INVITATION_PATH,
          handler: (_req, res) => {
            sendJsonError(res, 501, 'not_implemented')
          },
        }),
      'dsh-web-login: /auth/github/invitation',
    )
  }

  ctx.provide?.(READY_SERVICE, true, () => true)
  ctx.set?.(READY_SERVICE, true)

  if (options.githubEnabled) {
    ctx.logger.info(
      `dsh-web-login: gate active (github, lifecycle=${lifecycle}); sign in at /login`,
    )
    if (authLoadError !== undefined) {
      ctx.logger.warn(`dsh-web-login: authorization state invalid: ${authLoadError}`)
    }
  } else {
    ctx.logger.info('dsh-web-login: gate active; sign in at /login')
  }
}
