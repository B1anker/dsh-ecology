import { expect, test } from '@rstest/core'
import { type AttemptLimiter, createAttemptLimiter } from '../../src/attempt-limiter.js'

/** A limiter with a controllable clock. */
function fixture(overrides: Partial<Parameters<typeof createAttemptLimiter>[0]> = {}): {
  limiter: AttemptLimiter
  advance: (ms: number) => void
} {
  let clock = 1_000_000
  const limiter = createAttemptLimiter({
    limit: 3,
    windowMs: 10_000,
    blockMs: 5000,
    maxClients: 10,
    now: () => clock,
    ...overrides,
  })
  return {
    limiter,
    advance: (ms) => {
      clock += ms
    },
  }
}

test('an unknown client is never blocked', () => {
  const { limiter } = fixture()
  expect(limiter.retryAfterMs('1.2.3.4')).toBe(0)
})

test('the block lands on the configured attempt and reports the wait', () => {
  const { limiter } = fixture({ limit: 3, blockMs: 5000 })
  expect(limiter.fail('a')).toBe(0)
  expect(limiter.fail('a')).toBe(0)
  expect(limiter.fail('a')).toBe(5000)
  expect(limiter.retryAfterMs('a')).toBe(5000)
})

test('the block expires after blockMs', () => {
  const { limiter, advance } = fixture({ limit: 2, blockMs: 5000 })
  limiter.fail('a')
  limiter.fail('a')
  advance(4999)
  expect(limiter.retryAfterMs('a')).toBe(1)
  advance(1)
  expect(limiter.retryAfterMs('a')).toBe(0)
})

test('clients are throttled independently', () => {
  const { limiter } = fixture({ limit: 2 })
  limiter.fail('a')
  limiter.fail('a')
  expect(limiter.retryAfterMs('a')).toBeGreaterThan(0)
  expect(limiter.retryAfterMs('b')).toBe(0)
})

test('an elapsed window resets the count', () => {
  const { limiter, advance } = fixture({ limit: 3, windowMs: 10_000 })
  limiter.fail('a')
  limiter.fail('a')
  advance(10_000)
  // A typo months apart should not accumulate towards a block.
  expect(limiter.fail('a')).toBe(0)
  expect(limiter.retryAfterMs('a')).toBe(0)
})

test('a successful login clears the record', () => {
  const { limiter } = fixture({ limit: 3 })
  limiter.fail('a')
  limiter.fail('a')
  limiter.succeed('a')
  expect(limiter.size).toBe(0)
  expect(limiter.fail('a')).toBe(0)
})

test('storage is bounded so a spoofable client key cannot grow the map', () => {
  const { limiter } = fixture({ maxClients: 3, limit: 5 })
  for (let index = 0; index < 50; index += 1) limiter.fail(`client-${index}`)
  expect(limiter.size).toBe(3)
})

test('an existing client is still counted once the map is full', () => {
  const { limiter } = fixture({ maxClients: 2, limit: 3 })
  limiter.fail('a')
  limiter.fail('b')
  limiter.fail('c')
  expect(limiter.size).toBe(2)
  // The tracked clients keep working; only new keys are dropped.
  expect(limiter.fail('a')).toBe(0)
  expect(limiter.fail('a')).toBe(5000)
})

test('sweep keeps blocked and in-window records, drops the rest', () => {
  const { limiter, advance } = fixture({ limit: 3, windowMs: 10_000, blockMs: 60_000 })
  limiter.fail('blocked')
  limiter.fail('blocked')
  limiter.fail('blocked')
  limiter.fail('recent')
  advance(11_000)
  limiter.sweep()
  expect(limiter.retryAfterMs('blocked')).toBeGreaterThan(0)
  expect(limiter.size, 'the in-window record aged out, the block did not').toBe(1)
})
