import { expect, test } from '@rstest/core'
import { createOAuthStateStore, pkceChallenge } from '../../src/oauth-state.js'

test('pkceChallenge is a stable S256 base64url digest', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('open returns an unguessable state and matching challenge', () => {
  const store = createOAuthStateStore({ ttlMs: 60_000, maxPending: 10 })
  const opened = store.open({ intent: 'login' })
  expect(opened).not.toBeNull()
  expect(opened?.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(opened?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(store.size).toBe(1)
})

test('consume returns the pending record once and then forgets it', () => {
  const store = createOAuthStateStore({ ttlMs: 60_000, maxPending: 10 })
  const opened = store.open({ intent: 'enroll-owner', initiatorSessionId: 'sess' })
  expect(opened).not.toBeNull()
  const pending = store.consume(opened?.state)
  expect(pending?.intent).toBe('enroll-owner')
  expect(pending?.initiatorSessionId).toBe('sess')
  expect(pending?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(pkceChallenge(pending!.codeVerifier)).toBe(opened!.codeChallenge)
  expect(store.consume(opened?.state)).toBeUndefined()
  expect(store.size).toBe(0)
})

test('expired and unknown states are consumed as misses', () => {
  let clock = 1_000_000
  const store = createOAuthStateStore({
    ttlMs: 1000,
    maxPending: 10,
    now: () => clock,
  })
  const opened = store.open({ intent: 'login' })
  clock += 1001
  expect(store.consume(opened?.state)).toBeUndefined()
  expect(store.consume('missing')).toBeUndefined()
  expect(store.consume(undefined)).toBeUndefined()
})

test('at capacity the store refuses rather than evicting', () => {
  const store = createOAuthStateStore({ ttlMs: 60_000, maxPending: 1 })
  expect(store.open({ intent: 'login' })).not.toBeNull()
  expect(store.open({ intent: 'login' })).toBeNull()
  expect(store.size).toBe(1)
})

test('sweep drops only expired pending states', () => {
  let clock = 1_000_000
  const store = createOAuthStateStore({
    ttlMs: 1000,
    maxPending: 10,
    now: () => clock,
  })
  const old = store.open({ intent: 'login' })
  clock += 600
  const fresh = store.open({ intent: 'login' })
  clock += 500
  store.sweep()
  expect(store.consume(old?.state)).toBeUndefined()
  expect(store.consume(fresh?.state)?.intent).toBe('login')
})
