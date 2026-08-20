import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionStore } from '../../src/sessions.js'

/** A store with a controllable clock. */
function fixture({ ttlMs = 1000, maxSessions = 10 } = {}) {
  let clock = 1_000_000
  const store = createSessionStore({ ttlMs, maxSessions, now: () => clock })
  return { store, advance: (ms) => { clock += ms } }
}

test('an opened session is live and unique', () => {
  const { store } = fixture()
  const a = store.open()
  const b = store.open()
  assert.notEqual(a, b)
  assert.ok(store.isLive(a))
  assert.ok(store.isLive(b))
  assert.equal(store.size, 2)
})

test('session ids are long and url-safe', () => {
  const { store } = fixture()
  const id = store.open()
  // 32 random bytes as base64url: no padding, nothing needing cookie escaping.
  assert.match(id, /^[A-Za-z0-9_-]{43}$/)
})

test('unknown and non-string ids are not live', () => {
  const { store } = fixture()
  store.open()
  for (const bad of ['nope', '', undefined, null, 0, {}]) {
    assert.equal(store.isLive(bad), false)
  }
})

test('a session expires exactly at its TTL and is dropped on lookup', () => {
  const { store, advance } = fixture({ ttlMs: 1000 })
  const id = store.open()
  advance(999)
  assert.equal(store.isLive(id), true)
  advance(1)
  assert.equal(store.isLive(id), false)
  assert.equal(store.size, 0, 'lookup should have evicted the expired entry')
})

test('revoke ends a session immediately', () => {
  const { store } = fixture()
  const id = store.open()
  store.revoke(id)
  assert.equal(store.isLive(id), false)
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
  assert.equal(store.size, 1)
  assert.equal(store.isLive(old), false)
  assert.equal(store.isLive(fresh), true)
})

test('at capacity the store refuses rather than evicting a live session', () => {
  const { store } = fixture({ maxSessions: 2 })
  const a = store.open()
  const b = store.open()
  assert.equal(store.open(), null)
  // Signing an active operator out to admit an unauthenticated flood would turn
  // a memory limit into a denial of service against the legitimate user.
  assert.ok(store.isLive(a))
  assert.ok(store.isLive(b))
})

test('capacity frees up once sessions expire', () => {
  const { store, advance } = fixture({ ttlMs: 1000, maxSessions: 1 })
  const first = store.open()
  assert.equal(store.open(), null)
  advance(1001)
  const second = store.open()
  assert.ok(second)
  assert.equal(store.isLive(first), false)
})
