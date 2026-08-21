/**
 * Failed-login throttling.
 *
 * scrypt is intentionally expensive, which makes the unauthenticated `POST
 * /login` handler the most costly route in the process: without a limiter, a
 * single client can pin a core by guessing. The limiter counts failures per
 * client and starts refusing *before* the KDF runs, so a blocked client costs a
 * map lookup rather than 16 MiB of hashing.
 *
 * Two things about that defence are not obvious, and both are the difference
 * between a limiter and the appearance of one.
 *
 * The first is that per-client counting assumes clients are scarce, and for an
 * attacker they are not: see
 * {@link module:@seaveyon/dsh-web-login/client-address} for how an address
 * becomes a bucket. So there is also a budget on total failures, across every
 * client, in the same window. That budget is what a caller spread across a
 * thousand addresses actually runs into.
 *
 * The second is what happens when storage fills. Storage has to be bounded — an
 * unbounded map is the leak the limiter was supposed to prevent — but a bounded
 * map has a failure mode, and the choice of failure mode is the whole design.
 * An earlier version of this file simply stopped tracking new clients at
 * capacity, which meant that filling the table *disabled throttling for every
 * client not already in it*. A caller who could reach capacity therefore got
 * unlimited guesses by doing so. Capacity now denies rather than admits.
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
  /** Failures across all clients, in one window, before everyone is blocked. */
  globalLimit: number
  /** How long a spent global budget blocks for. */
  globalBlockMs: number
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
  /** Whether the shared budget is currently spent. */
  readonly globallyBlocked: boolean
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
 * @param options - `limit`, `windowMs`, `blockMs`, `maxClients`, the shared
 *   `globalLimit` and `globalBlockMs`, and an injectable `now` for tests.
 * @returns the limiter's operations.
 */
export function createAttemptLimiter({
  limit,
  windowMs,
  blockMs,
  maxClients,
  globalLimit,
  globalBlockMs,
  now = Date.now,
}: AttemptLimiterOptions): AttemptLimiter {
  const clients = new Map<string, AttemptRecord>()

  /** Failures counted across every client in the current window. */
  let globalCount = 0
  /** When the current global window opened. */
  let globalFirst = 0
  /** When the global block expires; 0 when not blocked. */
  let globalBlockedUntil = 0

  /** @returns milliseconds until the shared block lifts, or 0. */
  const globalRetryMs = (): number => {
    const remaining = globalBlockedUntil - now()
    return remaining > 0 ? remaining : 0
  }

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
     * Whether a client is currently blocked, by its own record or by the
     * shared budget.
     *
     * Called on every login POST before the body is read, so it stays a pair of
     * lookups and no allocation.
     *
     * @param key - client bucket, normally a masked address.
     * @returns milliseconds remaining, or 0 when not blocked.
     */
    retryAfterMs(key) {
      const global = globalRetryMs()
      const record = clients.get(key)
      if (record === undefined) {
        // At capacity there is deliberately nowhere to store another key. Letting
        // an unknown client through here and only refusing it after the KDF would
        // make every retry pay the full scrypt cost again, because `fail()` could
        // not leave a blocked record for the next preflight. Refuse before the
        // body and KDF instead. A successful tracked client or the periodic sweep
        // frees a slot and makes newcomers eligible again.
        if (clients.size >= maxClients) return Math.max(global, blockMs)
        return global
      }
      const remaining = record.blockedUntil - now()
      return Math.max(global, remaining > 0 ? remaining : 0)
    },

    /**
     * Record a failed attempt and block the client once it crosses the limit.
     * @param key - client bucket.
     * @returns milliseconds the client must now wait, or 0 when still allowed.
     */
    fail(key) {
      sweep()
      const at = now()

      // The shared budget is counted first, so it applies even on the paths
      // below that decline to create a per-client record.
      if (globalFirst + windowMs <= at) {
        globalFirst = at
        globalCount = 0
      }
      globalCount += 1
      if (globalCount >= globalLimit) {
        globalBlockedUntil = at + globalBlockMs
        globalCount = 0
        globalFirst = at
      }
      const global = globalRetryMs()

      let record = clients.get(key)
      if (record === undefined || record.first + windowMs <= at) {
        if (record === undefined && clients.size >= maxClients) {
          // Capacity, and this client is not in the table. Tracking it would
          // mean unbounded memory; ignoring it would mean unbounded guesses.
          // The third option is this one: refuse the untracked client for a
          // full block interval. It costs a legitimate newcomer a wait during
          // an attack, and it costs the attacker the thing they were buying.
          return Math.max(global, blockMs)
        }
        // A window that has elapsed resets the count, so an occasional typo does
        // not accumulate towards a block over days.
        record = { count: 0, first: at, blockedUntil: 0 }
        clients.set(key, record)
      }
      record.count += 1
      if (record.count >= limit) {
        record.blockedUntil = at + blockMs
        record.count = 0
        record.first = at
        return Math.max(global, blockMs)
      }
      return global
    },

    /**
     * Clear a client's record after a successful login.
     *
     * The shared counter is cleared too. Only someone holding the password can
     * reach this, and their presence is the evidence the counter was looking
     * for — leaving it to accumulate would let a slow background attack lock
     * the operator out of a server they can demonstrably sign in to. An active
     * global *block* is left alone, since it cannot be reached from here: a
     * blocked caller never gets as far as being verified.
     *
     * @param key - client bucket.
     */
    succeed(key) {
      clients.delete(key)
      globalCount = 0
      globalFirst = now()
    },

    /** Drop stale records. Exposed for the periodic sweep and for tests. */
    sweep,

    /** @returns the number of tracked clients. */
    get size() {
      return clients.size
    },

    /** @returns whether the shared budget is currently spent. */
    get globallyBlocked() {
      return globalRetryMs() > 0
    },
  }
}
