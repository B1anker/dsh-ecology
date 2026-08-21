import { expect, test } from '@rstest/core'
import {
  readCookie,
  SESSION_COOKIE_BASE,
  SESSION_COOKIE_PREFIX,
  serializeClearedCookies,
  serializeSessionCookie,
  sessionCookieName,
} from '../../src/cookies.js'

const NAME = sessionCookieName(true)

test('readCookie finds a value among others and tolerates spacing', () => {
  expect(readCookie(`a=1; ${NAME}=xyz; b=2`, NAME)).toBe('xyz')
  expect(readCookie(`${NAME}=xyz`, NAME)).toBe('xyz')
  expect(readCookie(`  ${NAME}  =  xyz  `, NAME)).toBe('xyz')
})

test('readCookie percent-decodes values', () => {
  expect(readCookie(`${NAME}=a%20b`, NAME)).toBe('a b')
})

test('readCookie returns undefined instead of throwing on a bad header', () => {
  // decodeURIComponent throws on a lone '%'. This runs on every request,
  // including unauthenticated ones, so a hostile cookie must look like none.
  expect(readCookie(`${NAME}=%`, NAME)).toBeUndefined()
  expect(readCookie(`${NAME}=%E0%A4%A`, NAME)).toBeUndefined()
  // The header is typed `unknown` precisely so these reach the function: it is
  // handed `req.headers.cookie`, which is absent far more often than not.
  for (const header of [undefined, null, 42, '', 'novalue', 'other=1']) {
    expect(readCookie(header, NAME), JSON.stringify(header)).toBeUndefined()
  }
})

test('readCookie refuses a duplicated name rather than choosing between them', () => {
  // The Cookie header carries names and values and nothing else, so a duplicate
  // planted from a wider scope is indistinguishable here from the real one.
  // Taking the first would be a guess, and browsers order by descending path
  // length — which means a cookie planted at a longer path is the one that
  // arrives first.
  expect(readCookie(`${NAME}=planted; ${NAME}=real`, NAME)).toBeUndefined()
  expect(readCookie(`${NAME}=real; ${NAME}=planted`, NAME)).toBeUndefined()
  expect(readCookie(`a=1; ${NAME}=one; b=2; ${NAME}=two`, NAME)).toBeUndefined()
})

test('readCookie accepts the same value repeated', () => {
  // One cookie the browser happened to send twice is not ambiguous, and
  // refusing it would sign the operator out for no reason.
  expect(readCookie(`${NAME}=same; ${NAME}=same`, NAME)).toBe('same')
})

test('readCookie does not match a name by suffix or prefix', () => {
  expect(readCookie(`x${NAME}=no`, NAME)).toBeUndefined()
  expect(readCookie(`${NAME}x=no`, NAME)).toBeUndefined()
})

test('the secure cookie name carries the __Host- prefix', () => {
  // The prefix is what makes host scoping something the browser enforces: it
  // will not accept such a cookie unless it is Secure, Path=/, and has no
  // Domain, and a sibling subdomain cannot satisfy all three for our host.
  expect(sessionCookieName(true)).toBe(`${SESSION_COOKIE_PREFIX}${SESSION_COOKIE_BASE}`)
  // The prefix requires Secure, so the plain-HTTP development mode cannot have
  // it. That trade is explicit rather than silent.
  expect(sessionCookieName(false)).toBe(SESSION_COOKIE_BASE)
})

test('session cookie carries the hardening attributes and no Domain', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
  expect(value).toBe(`${NAME}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure`)
  expect(value.includes('Domain'), 'Domain would share the session with sibling subdomains').toBe(
    false,
  )
})

test('the secure cookie satisfies every condition the __Host- prefix requires', () => {
  // A browser silently drops a __Host- cookie that breaks any of these, and the
  // symptom would be a login that appears to succeed and never takes effect.
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
  expect(value.startsWith(`${SESSION_COOKIE_PREFIX}`)).toBe(true)
  expect(value).toMatch(/; Secure(;|$)/)
  expect(value).toMatch(/; Path=\/(;|$)/)
  expect(value.includes('Domain=')).toBe(false)
})

test('Secure is omitted only when explicitly disabled', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: false })
  expect(value.includes('Secure')).toBe(false)
  expect(value.includes('HttpOnly')).toBe(true)
  expect(value.startsWith(`${SESSION_COOKIE_BASE}=`)).toBe(true)
})

test('Max-Age is an integer even for a fractional TTL', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 1.9, secure: true })
  expect(value).toMatch(/Max-Age=1(;|$)/)
})

// A browser matches on name, path, and domain: a clear that differs in any of
// them leaves the original cookie — and the session — in place. This strips the
// one attribute the two cookies are allowed to differ in.
const attrs = (value: string): string[] =>
  value
    .split('; ')
    .slice(1)
    .filter((attribute) => !attribute.startsWith('Max-Age'))

test('the cleared cookie mirrors the attributes of the one it clears', () => {
  for (const secure of [true, false]) {
    const set = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure })
    const [clear] = serializeClearedCookies({ secure })
    expect(clear, `secure: ${secure}`).toBeDefined()
    expect(attrs(clear ?? ''), `secure: ${secure}`).toEqual(attrs(set))
    expect(clear).toMatch(/Max-Age=0/)
    expect(clear?.startsWith(`${sessionCookieName(secure)}=;`)).toBe(true)
  }
})

test('logout also expires the pre-prefix cookie name', () => {
  // Nothing reads it any more, so it is inert — but a deployment upgrading into
  // the prefixed name leaves it in every browser that ever signed in, where the
  // next person to open developer tools finds a session cookie that looks live.
  const cleared = serializeClearedCookies({ secure: true })
  expect(cleared).toHaveLength(2)
  expect(cleared.some((value) => value.startsWith(`${SESSION_COOKIE_BASE}=;`))).toBe(true)

  // Without Secure there was never a prefixed name to leave behind.
  expect(serializeClearedCookies({ secure: false })).toHaveLength(1)
})
