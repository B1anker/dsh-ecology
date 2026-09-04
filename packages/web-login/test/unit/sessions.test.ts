import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import {
  createSessionStore,
  PASSWORD_PRINCIPAL,
  type SessionPrincipal,
  type SessionStore,
} from '../../src/sessions.js'

const GITHUB_OWNER: SessionPrincipal = {
  provider: 'github',
  githubUserId: 42,
  githubLogin: 'octocat',
  role: 'owner',
  authzVersion: 1,
}

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
  const a = store.open(PASSWORD_PRINCIPAL)
  const b = store.open(PASSWORD_PRINCIPAL)
  expect(a).not.toBe(b)
  expect(store.isLive(a)).toBe(true)
  expect(store.isLive(b)).toBe(true)
  expect(store.size).toBe(2)
})

test('session ids are long and url-safe', () => {
  const { store } = fixture()
  // 32 random bytes as base64url: no padding, nothing needing cookie escaping.
  expect(store.open(PASSWORD_PRINCIPAL)).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

test('unknown and non-string ids are not live', () => {
  const { store } = fixture()
  store.open(PASSWORD_PRINCIPAL)
  // `isLive` takes `unknown` because its argument comes from a cookie header;
  // these are the shapes a missing or hostile cookie actually produces.
  for (const id of ['nope', '', undefined, null, 0, {}]) {
    expect(store.isLive(id), JSON.stringify(id)).toBe(false)
  }
})

test('a session expires exactly at its TTL and is dropped on lookup', () => {
  const { store, advance } = fixture({ ttlMs: 1000 })
  const id = store.open(PASSWORD_PRINCIPAL)
  advance(999)
  expect(store.isLive(id)).toBe(true)
  advance(1)
  expect(store.isLive(id)).toBe(false)
  expect(store.size, 'lookup should have evicted the expired entry').toBe(0)
})

test('revoke ends a session immediately', () => {
  const { store } = fixture()
  const id = store.open(PASSWORD_PRINCIPAL)
  store.revoke(id)
  expect(store.isLive(id)).toBe(false)
  // Revoking twice, or revoking nothing, is what a logout with a stale or
  // missing cookie does; neither may throw on a public endpoint.
  store.revoke(id)
  store.revoke(undefined)
})

test('sweep drops only expired sessions', () => {
  const { store, advance } = fixture({ ttlMs: 1000 })
  const old = store.open(PASSWORD_PRINCIPAL)
  advance(600)
  const fresh = store.open(PASSWORD_PRINCIPAL)
  advance(500)
  store.sweep()
  expect(store.size).toBe(1)
  expect(store.isLive(old)).toBe(false)
  expect(store.isLive(fresh)).toBe(true)
})

test('at capacity the store refuses rather than evicting a live session', () => {
  const { store } = fixture({ maxSessions: 2 })
  const a = store.open(PASSWORD_PRINCIPAL)
  const b = store.open(PASSWORD_PRINCIPAL)
  expect(store.open(PASSWORD_PRINCIPAL)).toBeNull()
  // Signing an active operator out to admit an unauthenticated flood would turn
  // a memory limit into a denial of service against the legitimate user.
  expect(store.isLive(a)).toBe(true)
  expect(store.isLive(b)).toBe(true)
})

test('capacity frees up once sessions expire', () => {
  const { store, advance } = fixture({ ttlMs: 1000, maxSessions: 1 })
  const first = store.open(PASSWORD_PRINCIPAL)
  expect(store.open(PASSWORD_PRINCIPAL)).toBeNull()
  advance(1001)
  expect(store.open(PASSWORD_PRINCIPAL)).not.toBeNull()
  expect(store.isLive(first)).toBe(false)
})

test('get returns the principal for a live session', () => {
  const { store } = fixture()
  const id = store.open(GITHUB_OWNER)
  expect(store.get(id)?.principal).toEqual(GITHUB_OWNER)
})

test('revokePrincipal drops every session for a GitHub user', () => {
  const { store } = fixture()
  const keep = store.open({
    ...GITHUB_OWNER,
    githubUserId: 99,
  })
  store.open(GITHUB_OWNER)
  store.open(GITHUB_OWNER)
  expect(store.revokePrincipal(42)).toBe(2)
  expect(store.isLive(keep)).toBe(true)
  expect(store.size).toBe(1)
})

test('revokeAll clears the store', () => {
  const { store } = fixture()
  store.open(PASSWORD_PRINCIPAL)
  store.open(GITHUB_OWNER)
  store.revokeAll()
  expect(store.size).toBe(0)
})

test('a private store restores unexpired sessions after restart and persists revocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-login-sessions-'))
  const file = join(dir, 'sessions.json')
  try {
    const first = createSessionStore({ ttlMs: 1000, maxSessions: 10, persistentFile: file })
    const id = first.open(PASSWORD_PRINCIPAL)
    expect(
      createSessionStore({ ttlMs: 1000, maxSessions: 10, persistentFile: file }).isLive(id),
    ).toBe(true)
    first.revoke(id)
    expect(
      createSessionStore({ ttlMs: 1000, maxSessions: 10, persistentFile: file }).isLive(id),
    ).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
