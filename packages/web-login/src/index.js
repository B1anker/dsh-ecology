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
 *   - Sessions are opaque random ids behind an HttpOnly, SameSite=Strict
 *     cookie, held in memory. A restart signs everyone out, which is the right
 *     trade for a single-operator deployment: no key material on disk.
 *
 * Decoration alone is not sufficient, and this is the subtle part. dsh loader
 * entries activate concurrently, so a route owner that registers during the
 * same tick as this plugin could register *before* the decoration is installed
 * and never be guarded. The plugin therefore publishes a `dshWebLoginReady`
 * service only after all three registries are decorated, and route owners are
 * expected to inject it. See `examples/dsh-web/cordis.patch.yml`.
 *
 * The password is never stored here or in config. It is read from an
 * environment variable as an scrypt verifier produced by
 * `npx dsh-web-login-hash`, and compared in constant time.
 *
 * @module @seaveyon/dsh-web-login
 */

import { createAttemptLimiter } from './attempt-limiter.js'
import { resolveConfig } from './config.js'
import { COOKIE_NAME, readCookie, serializeClearedCookie, serializeSessionCookie } from './cookies.js'
import {
  clientKey,
  isDocumentNavigation,
  isFormPost,
  readBody,
  sendHtml,
  sendJsonError,
  sendRedirect,
} from './http.js'
import { renderLoginPage } from './page.js'
import { createSessionStore } from './sessions.js'
import { requireVerifier, verifyPassword } from './verifier.js'

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

/** Where a successful sign-in lands. Fixed, so there is no redirect parameter to poison. */
const HOME_PATH = '/'

/**
 * Mount the login gate.
 * @param ctx - plugin context carrying the `webServer` service.
 * @param config - plugin configuration from the dsh profile.
 */
export function apply(ctx, config) {
  // Validate before anything observable happens. A bad config or a missing
  // verifier must stop startup while the surface is still unreachable —
  // serving an open port because a variable was unset is the one outcome a
  // login plugin must never produce.
  const options = resolveConfig(config)
  const verifier = requireVerifier(process.env[options.passwordHashEnv], options.passwordHashEnv)

  const server = ctx.get('webServer')
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
  })

  /**
   * Whether a request carries a live session cookie.
   * @param req - the incoming request.
   * @returns true when the cookie names an unexpired session.
   */
  const isAuthenticated = (req) => sessions.isLive(readCookie(req.headers.cookie, COOKIE_NAME))

  // ── the gate ───────────────────────────────────────────────────────────────

  /**
   * Wrap a route handler so unauthenticated requests never reach it.
   *
   * Only a browser document navigation is redirected to the login page. An
   * `/api` fetch that received a 302 would follow it and get HTML where it
   * expected JSON, surfacing to the user as a parse error rather than a prompt
   * to sign in — so every non-navigation gets a 401 instead, even when it
   * happens to advertise `Accept: text/html`.
   *
   * @param handler - the route's own handler.
   * @param options - whether an HTML navigation may be redirected.
   * @returns the guarded handler.
   */
  const guard = (handler, { redirectNavigation = true } = {}) => async (req, res) => {
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

  // Decorate the registries rather than claiming paths: routes registered by
  // plugins loaded after this one are wrapped as they arrive, so coverage does
  // not depend on this plugin knowing the route table. `/api` in particular is
  // a prefix route owned by another plugin, and no second plugin may claim the
  // same (kind, path) pair or the fallback seat.
  const originalRegister = server.register.bind(server)
  const originalRegisterUpgrade = server.registerUpgrade.bind(server)
  const originalRegisterFallback = server.registerFallback.bind(server)

  const decoratedRegister = (route) => {
    // The gate's own routes must not be guarded, or signing in would require
    // already being signed in.
    if (route.kind === 'exact' && (route.path === LOGIN_PATH || route.path === LOGOUT_PATH)) {
      return originalRegister(route)
    }
    // Prefix routes are services and static assets (`/api`, `/plugins`, and
    // similar), not document destinations. Older clients may send only an
    // `Accept: text/html` header, which is otherwise our navigation fallback;
    // redirecting one of these routes would hand the caller HTML where it
    // expected its own representation. Exact routes and the SPA fallback can
    // still use that fallback for old-browser document navigation.
    return originalRegister({
      ...route,
      handler: guard(route.handler, { redirectNavigation: route.kind !== 'prefix' }),
    })
  }

  const decoratedRegisterUpgrade = (route) => originalRegisterUpgrade({
    ...route,
    handler: (req, socket, head) => {
      if (!isAuthenticated(req)) {
        // A rejected upgrade has no ServerResponse, so the status line goes onto
        // the raw socket by hand; dropping the connection instead would leave
        // the client reconnecting forever with no idea why.
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n'
          + 'Connection: close\r\n'
          + 'Cache-Control: no-store\r\n'
          + 'Content-Length: 0\r\n\r\n',
        )
        socket.end()
        return undefined
      }
      return route.handler(req, socket, head)
    },
  })

  const decoratedRegisterFallback = (handler) => originalRegisterFallback(guard(handler))

  server.register = decoratedRegister
  server.registerUpgrade = decoratedRegisterUpgrade
  server.registerFallback = decoratedRegisterFallback

  ctx.effect(() => () => {
    // Restore only what is still ours. If another plugin decorated on top of
    // this one, blindly reassigning the originals would silently remove *its*
    // wrapper too — including, potentially, another security boundary.
    if (server.register === decoratedRegister) server.register = originalRegister
    if (server.registerUpgrade === decoratedRegisterUpgrade) {
      server.registerUpgrade = originalRegisterUpgrade
    }
    if (server.registerFallback === decoratedRegisterFallback) {
      server.registerFallback = originalRegisterFallback
    }
  }, 'dsh-web-login: registry decoration')

  // Expired sessions are dropped on lookup, but an abandoned session that is
  // never looked up again would sit in the map until restart. The timer is
  // unreferenced so it cannot by itself hold the process open.
  const sweepTimer = setInterval(() => {
    sessions.sweep()
    limiter.sweep()
  }, options.sweepIntervalMs)
  sweepTimer.unref?.()
  ctx.effect(() => () => clearInterval(sweepTimer), 'dsh-web-login: expiry sweep')

  // ── the login surface ──────────────────────────────────────────────────────

  ctx.effect(() => server.register({
    kind: 'exact',
    path: LOGIN_PATH,
    handler: async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Someone already signed in has no business on this page.
        if (isAuthenticated(req)) {
          sendRedirect(res, 302, HOME_PATH)
          return
        }
        sendHtml(res, 200, renderLoginPage({ title: options.title }))
        return
      }
      if (req.method !== 'POST') {
        sendJsonError(res, 405, 'method_not_allowed', { allow: 'GET, HEAD, POST' })
        return
      }

      const key = clientKey(req, options)

      // Check the block *before* reading the body or running the KDF: scrypt is
      // the most expensive thing in this process by design, and a blocked
      // client must cost a map lookup, not 16 MiB of hashing.
      const blockedFor = limiter.retryAfterMs(key)
      if (blockedFor > 0) {
        const seconds = Math.ceil(blockedFor / 1000)
        sendHtml(res, 429, renderLoginPage({
          title: options.title,
          message: `Too many failed attempts. Try again in ${seconds} second(s).`,
        }), { 'retry-after': String(seconds) })
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
      if (!verifyPassword(password, verifier)) {
        const waitMs = limiter.fail(key)
        // The client identity is logged, never the password or the verifier:
        // startup and failure lines are the most-copied text in any bug report.
        ctx.logger.warn(`dsh-web-login: failed attempt from ${key}`)
        if (waitMs > 0) {
          const seconds = Math.ceil(waitMs / 1000)
          sendHtml(res, 429, renderLoginPage({
            title: options.title,
            message: `Too many failed attempts. Try again in ${seconds} second(s).`,
          }), { 'retry-after': String(seconds) })
          return
        }
        sendHtml(res, 401, renderLoginPage({
          title: options.title,
          message: 'Incorrect password. Please try again.',
        }))
        return
      }

      const id = sessions.open()
      if (id === null) {
        // Capacity is reported rather than met by evicting a live session:
        // signing the operator out to make room for a flood would turn a memory
        // limit into a denial of service against the legitimate user.
        ctx.logger.warn('dsh-web-login: session capacity reached; refusing new sign-in')
        sendHtml(res, 503, renderLoginPage({
          title: options.title,
          message: 'Too many active sessions. Try again later.',
        }), { 'retry-after': '60' })
        return
      }

      limiter.succeed(key)
      // 303 so the browser reissues as GET; a 302 after POST is re-submitted by
      // some clients on reload.
      sendRedirect(res, 303, HOME_PATH, {
        'set-cookie': serializeSessionCookie(id, {
          maxAgeSeconds: options.sessionTtlMs / 1000,
          secure: options.secureCookie,
        }),
      })
    },
  }), 'dsh-web-login: /login route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: LOGOUT_PATH,
    handler: (req, res) => {
      // POST only: a GET /logout would let any embedded image sign the user out.
      if (req.method !== 'POST') {
        sendJsonError(res, 405, 'method_not_allowed', { allow: 'POST' })
        return
      }
      sessions.revoke(readCookie(req.headers.cookie, COOKIE_NAME))
      sendRedirect(res, 303, LOGIN_PATH, {
        'set-cookie': serializeClearedCookie({ secure: options.secureCookie }),
      })
    },
  }), 'dsh-web-login: /logout route')

  // Published last. Anything that injects this service is guaranteed to see the
  // decorated registries, which is what makes route coverage deterministic
  // instead of dependent on loader timing.
  // The third `provide()` argument is an optional *function* that determines
  // availability. Passing `true` here makes Cordis call a boolean as a
  // function, leaving every injected route owner pending.
  ctx.provide?.(READY_SERVICE, true, () => true)
  ctx.set?.(READY_SERVICE, true)

  ctx.logger.info('dsh-web-login: gate active; sign in at /login')
}
