/**
 * Measure what a burst of password verifications does to the event loop.
 *
 * This is the measurement that justifies the synchronous-to-asynchronous change
 * in `src/verifier.ts` and the gate in `src/kdf-gate.ts`. It runs the same load
 * three ways and reports the loop lag each one causes:
 *
 *   sync    scryptSync, as the package did originally
 *   async   crypto.scrypt with no admission control
 *   gated   crypto.scrypt behind the bounded gate the package now uses
 *
 * Loop lag is sampled with a 10 ms interval: the delay between when a timer was
 * due and when it actually ran is, to within the sampling error, how long the
 * loop was unavailable to serve anything else. In the dsh process "anything
 * else" is every other HTTP request, WebSocket frame, and plugin timer.
 *
 * Usage: node bench/event-loop-lag.mjs [concurrency]
 *
 * Not shipped: `files` in package.json does not list this directory.
 */

import { randomBytes, scrypt, scryptSync } from 'node:crypto'

const SCRYPT = { keylen: 64, N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const SALT = randomBytes(16)
const SAMPLE_INTERVAL_MS = 10

const concurrency = Number(process.argv[2] ?? 8)
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error(`usage: node bench/event-loop-lag.mjs [concurrency]; got ${process.argv[2]}`)
  process.exit(2)
}

/** Sample how late a fixed-interval timer runs. */
function startLagSampler() {
  const lags = []
  let previous = process.hrtime.bigint()
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - previous) / 1e6
    previous = now
    lags.push(Math.max(0, elapsedMs - SAMPLE_INTERVAL_MS))
  }, SAMPLE_INTERVAL_MS)
  return () => {
    clearInterval(timer)
    return lags
  }
}

/** @returns `value` fixed to one decimal, right-aligned to `width`. */
function cell(value, width) {
  return value.toFixed(1).padStart(width)
}

/** @returns the value at `fraction` through a sorted copy of `values`. */
function quantile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}

function deriveAsync(password) {
  return new Promise((resolve, reject) => {
    scrypt(password, SALT, SCRYPT.keylen, SCRYPT, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

/** The gate from src/kdf-gate.ts, restated here so the bench has no build step. */
function createKdfGate({ concurrency: limit, queueDepth }) {
  const waiting = []
  let active = 0
  const release = () => {
    const next = waiting.shift()
    if (next === undefined) active -= 1
    else next()
  }
  return {
    async run(task) {
      if (active >= limit) {
        if (waiting.length >= queueDepth) return null
        await new Promise((resolve) => waiting.push(resolve))
      } else {
        active += 1
      }
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

const strategies = {
  async sync() {
    for (let i = 0; i < concurrency; i += 1) scryptSync(`pw${i}`, SALT, SCRYPT.keylen, SCRYPT)
    return { admitted: concurrency, refused: 0 }
  },

  async async() {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => deriveAsync(`pw${i}`)))
    return { admitted: concurrency, refused: 0 }
  },

  async gated() {
    const gate = createKdfGate({ concurrency: 2, queueDepth: 8 })
    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => gate.run(() => deriveAsync(`pw${i}`))),
    )
    const refused = results.filter((result) => result === null).length
    return { admitted: results.length - refused, refused }
  },
}

// Warm up so the first strategy measured does not also pay for lazy
// initialization inside OpenSSL.
scryptSync('warmup', SALT, SCRYPT.keylen, SCRYPT)

console.log(`concurrency: ${concurrency}   node: ${process.version}`)
console.log('strategy  wall(ms)  lag p50(ms)  lag p99(ms)  lag max(ms)  admitted  refused')

for (const [label, run] of Object.entries(strategies)) {
  const stop = startLagSampler()
  const started = process.hrtime.bigint()
  const { admitted, refused } = await run()
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6
  // Yield to the timers phase before stopping. The blocking strategy never lets
  // the sampler run at all while it works, so its entire cost shows up as one
  // catch-up tick afterwards — which is only recorded if the loop is allowed to
  // reach that tick.
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS * 5))
  const lags = stop()

  console.log(
    `${label.padEnd(9)} ${cell(wallMs, 8)}  ${cell(quantile(lags, 0.5), 11)}  ` +
      `${cell(quantile(lags, 0.99), 11)}  ${cell(Math.max(0, ...lags), 11)}  ` +
      `${String(admitted).padStart(8)}  ${String(refused).padStart(7)}`,
  )
}
