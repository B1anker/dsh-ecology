/**
 * Failed-login throttling.
 *
 * scrypt is intentionally expensive, which makes the unauthenticated `POST
 * /login` handler the most costly route in the process: without a limiter, a
 * single client can pin a core by guessing. The limiter counts failures per
 * client and starts refusing *before* the KDF runs, so a blocked client costs a
 * map lookup rather than 16 MiB of hashing.
 *
 * Storage is bounded. An attacker with a spoofable client key (see
 * `trustProxy` in {@link module:@seaveyon/dsh-web-login/config}) could otherwise
 * grow the map without limit, converting the defence into the leak.
 *
 * @module @seaveyon/dsh-web-login/attempt-limiter
 */

import type { Clock } from './sessions.js'

/** Construction options for {@link createAttemptLimiter}. */
export interface AttemptLimiterOptions {
  limit: number
  windowMs: number
  blockMs: number
  maxClients: number
  now?: Clock
}

/** The operations a limiter exposes. */
export interface AttemptLimiter {
  /** Milliseconds a client must still wait, or 0 when not blocked. */
  retryAfterMs: (key: string) => number
  /** Record a failure; returns the wait imposed, or 0 when still allowed. */
  fail: (key: string) => number
  /** Clear a client's record after a successful login. */
  succeed: (key: string) => void
  /** Drop stale records. */
  sweep: () => void
  /** The number of tracked clients. */
  readonly size: number
}

/** What is remembered per client. */
interface AttemptRecord {
  count: number
  first: number
  blockedUntil: number
}

/**
 * Create a failed-attempt limiter.
 *
 * @param options - `limit`, `windowMs`, `blockMs`, `maxClients`, and an
 *   injectable `now` for tests.
 * @returns the limiter's operations.
 */
export function createAttemptLimiter({
  limit,
  windowMs,
  blockMs,
  maxClients,
  now = Date.now,
}: AttemptLimiterOptions): AttemptLimiter {
  const clients = new Map<string, AttemptRecord>()

  /** Drop records that are neither blocked nor inside their window. */
  const sweep = (): void => {
    const cutoff = now()
    for (const [key, record] of clients) {
      if (record.blockedUntil > cutoff) continue
      if (record.first + windowMs > cutoff) continue
      clients.delete(key)
    }
  }

  return {
    /**
     * Whether a client is currently blocked.
     * @param key - client identity, normally its IP address.
     * @returns milliseconds remaining, or 0 when not blocked.
     */
    retryAfterMs(key) {
      const record = clients.get(key)
      if (record === undefined) return 0
      const remaining = record.blockedUntil - now()
      return remaining > 0 ? remaining : 0
    },

    /**
     * Record a failed attempt and block the client once it crosses the limit.
     * @param key - client identity.
     * @returns milliseconds the client must now wait, or 0 when still allowed.
     */
    fail(key) {
      sweep()
      const at = now()
      let record = clients.get(key)
      // A window that has elapsed resets the count, so an occasional typo does
      // not accumulate towards a block over days.
      if (record === undefined || record.first + windowMs <= at) {
        if (record === undefined && clients.size >= maxClients) return 0
        record = { count: 0, first: at, blockedUntil: 0 }
        clients.set(key, record)
      }
      record.count += 1
      if (record.count >= limit) {
        record.blockedUntil = at + blockMs
        record.count = 0
        record.first = at
        return blockMs
      }
      return 0
    },

    /**
     * Clear a client's record after a successful login.
     * @param key - client identity.
     */
    succeed(key) {
      clients.delete(key)
    },

    /** Drop stale records. Exposed for the periodic sweep and for tests. */
    sweep,

    /** @returns the number of tracked clients. */
    get size() {
      return clients.size
    },
  }
}
