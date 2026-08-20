/**
 * Cookie parsing and serialization for the session cookie.
 *
 * Split out because both halves are easy to get subtly wrong in ways no
 * integration test notices: `decodeURIComponent` throws on a stray `%` and
 * would take down the request that carried it, and a cleared cookie whose
 * attributes do not match the one that was set is simply ignored by the
 * browser, leaving the user signed in after logout.
 *
 * @module @seaveyon/dsh-web-login/cookies
 */

/** Name of the cookie carrying the opaque session id. */
export const COOKIE_NAME = 'dsh_session'

/**
 * Read one cookie out of a Cookie header.
 *
 * A malformed header yields `undefined` rather than throwing: this runs on
 * every request, including unauthenticated ones, so a hostile cookie must be
 * indistinguishable from no cookie. When a name appears more than once the
 * first occurrence wins — picking the last would let an attacker-planted
 * duplicate from a wider scope shadow the real session.
 *
 * @param header - raw Cookie header value, or undefined when absent.
 * @param name - cookie name to read.
 * @returns the decoded value, or undefined when absent or unreadable.
 */
export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Serialize the session cookie.
 *
 * `Domain` is deliberately never set, which scopes the cookie to the exact host
 * that issued it; a `Domain` attribute would share the session with every
 * sibling subdomain.
 *
 * @param id - the session id to carry.
 * @param options - `maxAgeSeconds` and whether to mark the cookie `Secure`.
 * @returns a Set-Cookie value.
 */
export function serializeSessionCookie(id, { maxAgeSeconds, secure }) {
  const attrs = [
    `${COOKIE_NAME}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * Serialize the cookie that clears the session.
 *
 * The attributes must mirror {@link serializeSessionCookie} — a browser matches
 * on name, path, and domain, so a clear that omits `Path=/` silently leaves the
 * original cookie in place.
 *
 * @param options - whether the cookie being cleared was marked `Secure`.
 * @returns a Set-Cookie value that expires the session cookie.
 */
export function serializeClearedCookie({ secure }) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}
