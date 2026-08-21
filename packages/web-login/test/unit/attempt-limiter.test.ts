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
    // Far out of reach unless a test asks for it, so the per-client assertions
    // below are not quietly measuring the shared budget instead.
    globalLimit: 1_000_000,
    globalBlockMs: 30_000,
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
  // The tracked clients keep working; only new keys go untracked.
  expect(limiter.fail('a')).toBe(0)
  expect(limiter.fail('a')).toBe(5000)
})

test('a client that cannot be tracked is denied rather than let through', () => {
  const { limiter } = fixture({ maxClients: 2, limit: 3, blockMs: 5000 })
  limiter.fail('a')
  limiter.fail('b')

  // The failure mode that matters. Not tracking an untracked client would mean
  // that filling the table buys unlimited guesses for every key not in it, so
  // reaching capacity would be the attack rather than the defence against it.
  expect(limiter.fail('c')).toBe(5000)
  expect(limiter.fail('d')).toBe(5000)
  expect(limiter.size, 'and it is still bounded').toBe(2)
})

test('capacity denial lifts as soon as sweeping frees a slot', () => {
  const { limiter, advance } = fixture({ maxClients: 2, limit: 3, windowMs: 10_000 })
  limiter.fail('a')
  limiter.fail('b')
  expect(limiter.fail('c')).toBe(5000)

  // Self-healing matters because the denial is collateral damage on honest
  // newcomers: it has to end the moment the table has room again, without an
  // operator noticing or a timer of its own.
  advance(10_001)
  expect(limiter.fail('c')).toBe(0)
})

test('the shared budget blocks a caller spread across many clients', () => {
  const { limiter } = fixture({ limit: 100, globalLimit: 10, globalBlockMs: 30_000 })

  // Every one of these is a different client and none of them reaches the
  // per-client limit, which is exactly the shape of a distributed attack: the
  // per-client counter never sees it.
  for (let index = 0; index < 9; index += 1) {
    expect(limiter.fail(`client-${index}`), `failure ${index}`).toBe(0)
  }
  expect(limiter.fail('client-9')).toBe(30_000)
  expect(limiter.globallyBlocked).toBe(true)
  expect(limiter.retryAfterMs('a-client-that-never-tried')).toBe(30_000)
})

test('the shared budget only counts failures inside one window', () => {
  const { limiter, advance } = fixture({ limit: 100, windowMs: 10_000, globalLimit: 5 })
  for (let index = 0; index < 4; index += 1) limiter.fail(`client-${index}`)
  advance(10_001)
  // Occasional failures spread over days are not an attack, and adding them up
  // forever would eventually block the whole server on the strength of them.
  expect(limiter.fail('client-x')).toBe(0)
  expect(limiter.globallyBlocked).toBe(false)
})

test('the shared block expires', () => {
  const { limiter, advance } = fixture({ limit: 100, globalLimit: 2, globalBlockMs: 30_000 })
  limiter.fail('a')
  limiter.fail('b')
  expect(limiter.globallyBlocked).toBe(true)
  advance(30_000)
  expect(limiter.globallyBlocked).toBe(false)
  expect(limiter.retryAfterMs('a')).toBe(0)
})

test('a successful login clears the shared counter', () => {
  const { limiter } = fixture({ limit: 100, globalLimit: 5 })
  for (let index = 0; index < 4; index += 1) limiter.fail(`client-${index}`)
  // Only someone holding the password reaches this, and their presence is the
  // evidence the counter was looking for. Letting a slow background attack lock
  // out an operator who can demonstrably sign in would be the wrong trade.
  limiter.succeed('client-0')
  expect(limiter.fail('client-9')).toBe(0)
  expect(limiter.globallyBlocked).toBe(false)
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
