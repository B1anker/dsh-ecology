/**
 * Bounded in-memory store for pending GitHub OAuth flows.
 *
 * State and PKCE verifiers must not live in the session cookie: that cookie is
 * `SameSite=Strict`, so a cross-site GitHub callback would not send it. Holding
 * them server-side behind an unguessable `state` parameter is the CSRF defence
 * and the only place a verifier may exist.
 *
 * @module @seaveyon/dsh-web-login/oauth-state
 */

import { createHash, randomBytes } from 'node:crypto'

/** Bytes of entropy for `state` and for the PKCE verifier. */
const ENTROPY_BYTES = 32

/** A clock, injectable so tests can advance time without waiting for it. */
export type Clock = () => number

/** Why a pending OAuth flow was opened. */
export type OAuthIntent = 'login' | 'enroll-owner' | 'accept-invitation'

/** A pending OAuth flow as the store holds it after `open`. */
export interface PendingOAuth {
  intent: OAuthIntent
  codeVerifier: string
  createdAt: number
  expiresAt: number
  initiatorSessionId?: string
  invitationDigest?: string
}

/** Construction options for {@link createOAuthStateStore}. */
export interface OAuthStateStoreOptions {
  ttlMs: number
  maxPending: number
  now?: Clock
}

/** What {@link OAuthStateStore.open} returns on success. */
export interface OpenedOAuthState {
  state: string
  codeChallenge: string
}

/** The operations an OAuth state store exposes. */
export interface OAuthStateStore {
  open: (
    input: Omit<PendingOAuth, 'codeVerifier' | 'createdAt' | 'expiresAt'>,
  ) => OpenedOAuthState | null
  consume: (state: unknown) => PendingOAuth | undefined
  sweep: () => void
  readonly size: number
}

/**
 * Build the S256 code challenge for a PKCE verifier.
 * @param verifier - the code verifier.
 * @returns the base64url-encoded SHA-256 digest.
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Create a pending-OAuth state store.
 *
 * @param options - TTL, capacity, and an injectable clock for tests.
 * @returns the store's operations.
 */
export function createOAuthStateStore({
  ttlMs,
  maxPending,
  now = Date.now,
}: OAuthStateStoreOptions): OAuthStateStore {
  const pending = new Map<string, PendingOAuth>()

  const sweep = (): void => {
    const cutoff = now()
    for (const [state, record] of pending) {
      if (record.expiresAt <= cutoff) pending.delete(state)
    }
  }

  return {
    /**
     * Open a new pending flow.
     *
     * At capacity the store refuses rather than evicting a still-valid flow:
     * dropping someone else's login to admit a flood would turn a memory bound
     * into a denial of service against honest users.
     *
     * @param input - intent and optional initiator / invitation binding.
     * @returns state + challenge, or null when full.
     */
    open(input) {
      sweep()
      if (pending.size >= maxPending) return null
      const state = randomBytes(ENTROPY_BYTES).toString('base64url')
      const codeVerifier = randomBytes(ENTROPY_BYTES).toString('base64url')
      const createdAt = now()
      pending.set(state, {
        ...input,
        codeVerifier,
        createdAt,
        expiresAt: createdAt + ttlMs,
      })
      return { state, codeChallenge: pkceChallenge(codeVerifier) }
    },

    /**
     * Consume a state exactly once, including on error and expiry paths.
     *
     * @param state - the `state` query parameter from the callback.
     * @returns the pending record when valid and unexpired; otherwise undefined.
     */
    consume(state) {
      if (typeof state !== 'string' || state === '') return undefined
      const record = pending.get(state)
      pending.delete(state)
      if (record === undefined) return undefined
      if (record.expiresAt <= now()) return undefined
      return record
    },

    sweep,

    get size() {
      return pending.size
    },
  }
}
