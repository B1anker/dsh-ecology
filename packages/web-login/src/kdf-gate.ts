/**
 * Bounded-concurrency gate for the key derivation function.
 *
 * scrypt is deliberately expensive: one derivation at the parameters in
 * {@link module:@seaveyon/dsh-web-login/verifier} costs roughly 80 milliseconds
 * of CPU and 16 MiB of working memory. Moving it off the main thread (see
 * `deriveKey`) stops it from blocking the event loop, but by itself that trades
 * one problem for another — libuv's threadpool has four threads by default, so
 * five concurrent sign-in attempts saturate it and every other consumer of that
 * pool in the dsh process (`fs` reads, DNS lookups, zlib) queues behind them.
 *
 * The per-client limiter cannot prevent that on its own, because a distributed
 * caller has as many client identities as it has addresses. So the number of
 * derivations in flight is capped here, process-wide and independent of who is
 * asking, with a bounded queue behind it. Past that queue the answer is a
 * refusal rather than a wait: an unauthenticated caller must never be able to
 * grow this process's memory or its latency without limit.
 *
 * @module @seaveyon/dsh-web-login/kdf-gate
 */

/** Construction options for {@link createKdfGate}. */
export interface KdfGateOptions {
  /** Derivations allowed to run at once. */
  concurrency: number
  /** Callers allowed to wait for a slot. Beyond this, work is refused. */
  queueDepth: number
}

/** The operations a gate exposes. */
export interface KdfGate {
  /**
   * Run `task` once a slot is free, or refuse when the queue is full.
   * @returns the task's result, or null when the gate refused to admit it.
   */
  run: <T>(task: () => Promise<T>) => Promise<T | null>
  /** Derivations currently running. */
  readonly active: number
  /** Callers currently waiting for a slot. */
  readonly queued: number
}

/**
 * Create a KDF gate.
 *
 * @param options - `concurrency` and `queueDepth`.
 * @returns the gate's operations.
 */
export function createKdfGate({ concurrency, queueDepth }: KdfGateOptions): KdfGate {
  /** Resolvers for callers waiting on a slot, oldest first. */
  const waiting: Array<() => void> = []
  let active = 0

  /**
   * Hand the freed slot to the oldest waiter, or leave it available.
   *
   * FIFO rather than LIFO so a caller that has already waited cannot be starved
   * by a steady arrival of newer ones — under load that would turn a queue into
   * a lottery, and the client who waited longest is the one closest to timing
   * out.
   */
  const release = (): void => {
    const next = waiting.shift()
    if (next === undefined) {
      active -= 1
      return
    }
    // The slot is transferred rather than released and re-taken: decrementing
    // here would open a window for an arriving caller to claim it ahead of the
    // waiter it was just promised to.
    next()
  }

  return {
    async run(task) {
      if (active >= concurrency) {
        if (waiting.length >= queueDepth) return null
        await new Promise<void>((resolve) => waiting.push(resolve))
      } else {
        active += 1
      }
      try {
        return await task()
      } finally {
        release()
      }
    },

    get active() {
      return active
    },

    get queued() {
      return waiting.length
    },
  }
}
