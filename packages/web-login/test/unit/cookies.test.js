import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COOKIE_NAME,
  readCookie,
  serializeClearedCookie,
  serializeSessionCookie,
} from '../../src/cookies.js'

test('readCookie finds a value among others and tolerates spacing', () => {
  assert.equal(readCookie(`a=1; ${COOKIE_NAME}=xyz; b=2`, COOKIE_NAME), 'xyz')
  assert.equal(readCookie(`${COOKIE_NAME}=xyz`, COOKIE_NAME), 'xyz')
  assert.equal(readCookie(`  ${COOKIE_NAME}  =  xyz  `, COOKIE_NAME), 'xyz')
})

test('readCookie percent-decodes values', () => {
  assert.equal(readCookie(`${COOKIE_NAME}=a%20b`, COOKIE_NAME), 'a b')
})

test('readCookie returns undefined instead of throwing on a bad header', () => {
  // decodeURIComponent throws on a lone '%'. This runs on every request,
  // including unauthenticated ones, so a hostile cookie must look like none.
  assert.equal(readCookie(`${COOKIE_NAME}=%`, COOKIE_NAME), undefined)
  assert.equal(readCookie(`${COOKIE_NAME}=%E0%A4%A`, COOKIE_NAME), undefined)
  for (const bad of [undefined, null, 42, '', 'novalue', 'other=1']) {
    assert.equal(readCookie(bad, COOKIE_NAME), undefined)
  }
})

test('readCookie takes the first occurrence of a duplicated name', () => {
  // A duplicate planted from a wider scope must not shadow the real session.
  assert.equal(readCookie(`${COOKIE_NAME}=real; ${COOKIE_NAME}=planted`, COOKIE_NAME), 'real')
})

test('readCookie does not match a name by suffix or prefix', () => {
  assert.equal(readCookie(`x${COOKIE_NAME}=no`, COOKIE_NAME), undefined)
  assert.equal(readCookie(`${COOKIE_NAME}x=no`, COOKIE_NAME), undefined)
})

test('session cookie carries the hardening attributes and no Domain', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
  assert.equal(value, `${COOKIE_NAME}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure`)
  assert.ok(!value.includes('Domain'), 'Domain would share the session with sibling subdomains')
})

test('Secure is omitted only when explicitly disabled', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: false })
  assert.ok(!value.includes('Secure'))
  assert.ok(value.includes('HttpOnly'))
})

test('Max-Age is an integer even for a fractional TTL', () => {
  const value = serializeSessionCookie('abc', { maxAgeSeconds: 1.9, secure: true })
  assert.match(value, /Max-Age=1(;|$)/)
})

test('the cleared cookie mirrors the attributes of the one it clears', () => {
  for (const secure of [true, false]) {
    const set = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure })
    const clear = serializeClearedCookie({ secure })
    // A browser matches on name, path, and domain: a clear that differs in any
    // of them leaves the original cookie — and the session — in place.
    const attrs = (value) => value.split('; ').slice(1).filter((a) => !a.startsWith('Max-Age'))
    assert.deepEqual(attrs(clear), attrs(set))
    assert.match(clear, /Max-Age=0/)
    assert.ok(clear.startsWith(`${COOKIE_NAME}=;`))
  }
})
