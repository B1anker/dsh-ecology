/**
 * Cookie parsing and serialization for the session cookie.
 *
 * Split out because both halves are easy to get subtly wrong in ways no
 * integration test notices: `decodeURIComponent` throws on a stray `%` and
 * would take down the request that carried it, and a cleared cookie whose
 * attributes do not match the one that was set is simply ignored by the
 * browser, leaving the user signed in after logout.
 *
 * The subtler problem this module solves is that a cookie's *name* is not a
 * namespace. Cookies are scoped by host and path, not by origin: any sibling
 * subdomain — and any network position that can answer for one over plain HTTP —
 * can set `dsh_session` with `Domain=example.com` and have the browser send it
 * to this application alongside the real one. That is cookie tossing, and the
 * defence is {@link SESSION_COOKIE_PREFIX}: a browser will only accept a
 * `__Host-` cookie that is `Secure`, has `Path=/`, and carries no `Domain`,
 * which together mean it can only have been set by this exact host.
 *
 * @module @seaveyon/dsh-web-login/cookies
 */

/** Base name of the cookie carrying the opaque session id. */
export const SESSION_COOKIE_BASE = 'dsh_session'

/**
 * The prefix that makes a cookie unforgeable by neighbours.
 *
 * A browser rejects a `__Host-` cookie unless it is `Secure`, has `Path=/`, and
 * has no `Domain` attribute. Those three conditions cannot be met by a sibling
 * subdomain setting a cookie for the parent domain, so a cookie with this name
 * that arrives here was set by this host.
 */
export const SESSION_COOKIE_PREFIX = '__Host-'

/**
 * The cookie name in use for a given configuration.
 *
 * The prefix requires `Secure`, so it is unavailable on the plain-HTTP loopback
 * setup `secureCookie: false` exists for. That is the honest trade rather than a
 * silent one: development gets the weaker name, and production — where a
 * neighbouring host is a real adversary — gets the strong one.
 *
 * @param secure - whether the deployment sets `Secure` on its cookies.
 * @returns the cookie name to set and to read.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `${SESSION_COOKIE_PREFIX}${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE
}

/**
 * Read one cookie out of a Cookie header.
 *
 * A malformed header yields `undefined` rather than throwing: this runs on
 * every request, including unauthenticated ones, so a hostile cookie must be
 * indistinguishable from no cookie.
 *
 * When the name appears more than once with different values, this returns
 * `undefined` rather than choosing. Choosing is not possible: the Cookie header
 * carries only names and values, so the duplicate that came from a wider scope
 * is indistinguishable here from the real one. An earlier version took the first
 * occurrence, on the reasoning that a planted cookie would sort later — but
 * browsers order cookies by descending path length first, so a duplicate planted
 * at a longer path sorts *earlier*, and "first wins" selected exactly the value
 * it was meant to exclude. Refusing both costs a signed-in operator a fresh
 * sign-in; picking wrong costs them the guarantee the cookie was for.
 *
 * The header parameter is `unknown` because it comes from Node's header map,
 * where a repeated header arrives as an array and a missing one as undefined;
 * narrowing happens here rather than at each of the call sites.
 *
 * @param header - raw Cookie header value, or undefined when absent.
 * @param name - cookie name to read.
 * @returns the decoded value, or undefined when absent, unreadable, or ambiguous.
 */
export function readCookie(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string') return undefined
  let found: string | undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    let value: string
    try {
      value = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    if (found === undefined) {
      found = value
      continue
    }
    // A repeat of the same value is one cookie the browser sent twice, which is
    // not ambiguous. A repeat with a different value is two cookies, and only
    // one of them can be ours.
    if (found !== value) return undefined
  }
  return found
}

/** How the session cookie should be scoped and how long it should live. */
export interface SessionCookieOptions {
  maxAgeSeconds: number
  secure: boolean
}

/**
 * Serialize the session cookie.
 *
 * `Domain` is deliberately never set, which scopes the cookie to the exact host
 * that issued it; a `Domain` attribute would share the session with every
 * sibling subdomain. With `secure`, the `__Host-` name additionally makes that
 * scoping something the browser enforces rather than something this code merely
 * refrains from widening.
 *
 * @param id - the session id to carry.
 * @param options - `maxAgeSeconds` and whether to mark the cookie `Secure`.
 * @returns a Set-Cookie value.
 */
export function serializeSessionCookie(
  id: string,
  { maxAgeSeconds, secure }: SessionCookieOptions,
): string {
  const attrs = [
    `${sessionCookieName(secure)}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * Serialize the cookies that clear the session.
 *
 * The attributes must mirror {@link serializeSessionCookie} — a browser matches
 * on name, path, and domain, so a clear that omits `Path=/` silently leaves the
 * original cookie in place.
 *
 * Two values are returned under `secure`, because a deployment upgrading into
 * the `__Host-` name still has the unprefixed cookie in every browser that ever
 * signed in to it. Nothing reads that cookie any more, so it is inert, but
 * leaving it behind means the next person to open developer tools finds a
 * session cookie that appears live and is not.
 *
 * @param options - whether the cookie being cleared was marked `Secure`.
 * @returns Set-Cookie values that expire the session cookie.
 */
export function serializeClearedCookies({ secure }: { secure: boolean }): string[] {
  /**
   * One clearing directive.
   * @param name - the cookie name to expire.
   * @returns the Set-Cookie value.
   */
  const clear = (name: string): string => {
    const attrs = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }
  const current = clear(sessionCookieName(secure))
  return secure ? [current, clear(SESSION_COOKIE_BASE)] : [current]
}
