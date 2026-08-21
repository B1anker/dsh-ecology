import { expect, test } from '@rstest/core'
import { createSessionStore, type SessionStore } from '../../src/sessions.js'

/** A store with a controllable clock. */
function fixture({ ttlMs = 1000, maxSessions = 10 } = {}): {
  store: SessionStore
  advance: (ms: number) => void
} {
  let clock = 1_000_000
  const store = createSessionStore({ ttlMs, maxSessions, now: () => clock })
  return {
    store,
    advance: (ms) => {
      clock += ms
    },
  }
}

test('an opened session is live and unique', () => {
  const { store } = fixture()
  const a = store.open()
  const b = store.open()
  expect(a).not.toBe(b)
  expect(store.isLive(a)).toBe(true)
  expect(store.isLive(b)).toBe(true)
  expect(store.size).toBe(2)
})

test('session ids are long and url-safe', () => {
  const { store } = fixture()
  // 32 random bytes as base64url: no padding, nothing needing cookie escaping.
  expect(store.open()).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

test('unknown and non-string ids are not live', () => {
  const { store } = fixture()
  store.open()
  // `isLive` takes `unknown` because its argument comes from a cookie header;
  // these are the shapes a missing or hostile cookie actually produces.
  for (const id of ['nope', '', undefined, null, 0, {}]) {
    expect(store.isLive(id), JSON.stringify(id)).toBe(false)
  }
})

test('a session expires exactly at its TTL and is dropped on lookup', () => {
  const { store, advance } = fixture({ ttlMs: 1000 })
  const id = store.open()
  advance(999)
  expect(store.isLive(id)).toBe(true)
  advance(1)
  expect(store.isLive(id)).toBe(false)
  expect(store.size, 'lookup should have evicted the expired entry').toBe(0)
})

test('revoke ends a session immediately', () => {
  const { store } = fixture()
  const id = store.open()
  store.revoke(id)
  expect(store.isLive(id)).toBe(false)
  // Revoking twice, or revoking nothing, is what a logout with a stale or
  // missing cookie does; neither may throw on a public endpoint.
  store.revoke(id)
  store.revoke(undefined)
})

test('sweep drops only expired sessions', () => {
  const { store, advance } = fixture({ ttlMs: 1000 })
  const old = store.open()
  advance(600)
  const fresh = store.open()
  advance(500)
  store.sweep()
  expect(store.size).toBe(1)
  expect(store.isLive(old)).toBe(false)
  expect(store.isLive(fresh)).toBe(true)
})

test('at capacity the store refuses rather than evicting a live session', () => {
  const { store } = fixture({ maxSessions: 2 })
  const a = store.open()
  const b = store.open()
  expect(store.open()).toBeNull()
  // Signing an active operator out to admit an unauthenticated flood would turn
  // a memory limit into a denial of service against the legitimate user.
  expect(store.isLive(a)).toBe(true)
  expect(store.isLive(b)).toBe(true)
})

test('capacity frees up once sessions expire', () => {
  const { store, advance } = fixture({ ttlMs: 1000, maxSessions: 1 })
  const first = store.open()
  expect(store.open()).toBeNull()
  advance(1001)
  expect(store.open()).not.toBeNull()
  expect(store.isLive(first)).toBe(false)
})
