import { expect, test } from '@rstest/core'
import {
  COOKIE_NAME,
  readCookie,
  serializeClearedCookie,
  serializeSessionCookie,
} from '../../src/cookies.js'

test('readCookie finds a value among others and tolerates spacing', () => {
  expect(readCookie(`a=1; ${COOKIE_NAME}=xyz; b=2`, COOKIE_NAME)).toBe('xyz')
  expect(readCookie(`${COOKIE_NAME}=xyz`, COOKIE_NAME)).toBe('xyz')
  expect(readCookie(`  ${COOKIE_NAME}  =  xyz  `, COOKIE_NAME)).toBe('xyz')
})

test('readCookie percent-decodes values', () => {
  expect(readCookie(`${COOKIE_NAME}=a%20b`, COOKIE_NAME)).toBe('a b')
})

test('readCookie returns undefined instead of throwing on a bad header', () => {
  // decodeURIComponent throws on a lone '%'. This runs on every request,
  // including unauthenticated ones, so a hostile cookie must look like none.
  expect(readCookie(`${COOKIE_NAME}=%`, COOKIE_NAME)).toBeUndefined()
  expect(readCookie(`${COOKIE_NAME}=%E0%A4%A`, COOKIE_NAME)).toBeUndefined()
  // The header is typed `unknown` precisely so these reach the function: it is
  // handed `req.headers.cookie`, which is absent far more often than not.
  for (const header of [undefined, null, 42, '', 'novalue', 'other=1']) {
    expect(readCookie(header, COOKIE_NAME), JSON.stringify(header)).toBeUndefined()
  }
})

test('readCookie takes the first occurrence of a duplicated name', () => {
  // A duplicate planted from a wider scope must not shadow the real session.
  expect(readCookie(`${COOKIE_NAME}=real; ${COOKIE_NAME}=planted`, COOKIE_NAME)).toBe('real')
})

test('readCookie does not match a name by suffix or prefix', () => {
  expect(readCookie(`x${COOKIE_NAME}=no`, COOKIE_NAME)).toBeUndefined()
  expect(readCookie(`${COOKIE_NAME}x=no`, COOKIE_NAME)).toBeUndefined()
})

test('session cookie carries the hardening attributes and no Domain', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
  expect(value).toBe(`${COOKIE_NAME}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure`)
  expect(value.includes('Domain'), 'Domain would share the session with sibling subdomains').toBe(
    false,
  )
})

test('Secure is omitted only when explicitly disabled', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: false })
  expect(value.includes('Secure')).toBe(false)
  expect(value.includes('HttpOnly')).toBe(true)
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
    const clear = serializeClearedCookie({ secure })
    expect(attrs(clear), `secure: ${secure}`).toEqual(attrs(set))
    expect(clear).toMatch(/Max-Age=0/)
    expect(clear.startsWith(`${COOKIE_NAME}=;`)).toBe(true)
  }
})
