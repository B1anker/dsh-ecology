/**
 * In-memory session store.
 *
 * Sessions are opaque random ids mapped to an expiry. Nothing is persisted, so
 * a restart signs everyone out — the deliberate trade for a single-operator
 * deployment: no key material and no session database on disk.
 *
 * @module @seaveyon/dsh-web-login/sessions
 */

import { randomBytes } from 'node:crypto'

/** Bytes of entropy per session id. */
const ID_BYTES = 32

/**
 * Create a session store.
 *
 * @param options - `ttlMs`, `maxSessions`, and an injectable `now` for tests.
 * @returns the store's operations.
 */
export function createSessionStore({ ttlMs, maxSessions, now = Date.now }) {
  /** @type {Map<string, number>} session id -> expiry in ms. */
  const sessions = new Map()

  /** Drop expired ids so a long-lived process does not accumulate them. */
  const sweep = () => {
    const cutoff = now()
    for (const [id, expiry] of sessions) {
      if (expiry <= cutoff) sessions.delete(id)
    }
  }

  return {
    /**
     * Mint a session.
     *
     * At capacity the store refuses rather than evicting the oldest live
     * session: silently signing an active operator out to make room for an
     * unauthenticated flood would turn a resource limit into a denial of
     * service against the legitimate user.
     *
     * @returns the new session id, or null when the store is full.
     */
     open() {
      sweep()
      if (sessions.size >= maxSessions) return null
      const id = randomBytes(ID_BYTES).toString('base64url')
      sessions.set(id, now() + ttlMs)
      return id
    },

    /**
     * Whether an id names a live session; expired ids are dropped on lookup.
     * @param id - candidate session id.
     * @returns true when the session is live.
     */
    isLive(id) {
      if (typeof id !== 'string' || id === '') return false
      const expiry = sessions.get(id)
      if (expiry === undefined) return false
      if (expiry <= now()) {
        sessions.delete(id)
        return false
      }
      return true
    },

    /**
     * Revoke a session.
     * @param id - session id to drop; a missing id is a no-op.
     */
    revoke(id) {
      if (typeof id === 'string') sessions.delete(id)
    },

    /** Drop expired sessions. Exposed for the periodic sweep and for tests. */
    sweep,

    /** @returns the number of sessions currently held, expired ones included. */
    get size() {
      return sessions.size
    },
  }
}
