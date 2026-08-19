import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAttemptLimiter } from '../../src/attempt-limiter.js'

/** A limiter with a controllable clock. */
function fixture(overrides = {}) {
  let clock = 1_000_000
  const limiter = createAttemptLimiter({
    limit: 3,
    windowMs: 10_000,
    blockMs: 5000,
    maxClients: 10,
    now: () => clock,
    ...overrides,
  })
  return { limiter, advance: (ms) => { clock += ms } }
}

test('an unknown client is never blocked', () => {
  const { limiter } = fixture()
  assert.equal(limiter.retryAfterMs('1.2.3.4'), 0)
})

test('the block lands on the configured attempt and reports the wait', () => {
  const { limiter } = fixture({ limit: 3, blockMs: 5000 })
  assert.equal(limiter.fail('a'), 0)
  assert.equal(limiter.fail('a'), 0)
  assert.equal(limiter.fail('a'), 5000)
  assert.equal(limiter.retryAfterMs('a'), 5000)
})

test('the block expires after blockMs', () => {
  const { limiter, advance } = fixture({ limit: 2, blockMs: 5000 })
  limiter.fail('a')
  limiter.fail('a')
  advance(4999)
  assert.equal(limiter.retryAfterMs('a'), 1)
  advance(1)
  assert.equal(limiter.retryAfterMs('a'), 0)
})

test('clients are throttled independently', () => {
  const { limiter } = fixture({ limit: 2 })
  limiter.fail('a')
  limiter.fail('a')
  assert.ok(limiter.retryAfterMs('a') > 0)
  assert.equal(limiter.retryAfterMs('b'), 0)
})

test('an elapsed window resets the count', () => {
  const { limiter, advance } = fixture({ limit: 3, windowMs: 10_000 })
  limiter.fail('a')
  limiter.fail('a')
  advance(10_000)
  // A typo months apart should not accumulate towards a block.
  assert.equal(limiter.fail('a'), 0)
  assert.equal(limiter.retryAfterMs('a'), 0)
})

test('a successful login clears the record', () => {
  const { limiter } = fixture({ limit: 3 })
  limiter.fail('a')
  limiter.fail('a')
  limiter.succeed('a')
  assert.equal(limiter.size, 0)
  assert.equal(limiter.fail('a'), 0)
})

test('storage is bounded so a spoofable client key cannot grow the map', () => {
  const { limiter } = fixture({ maxClients: 3, limit: 5 })
  for (let index = 0; index < 50; index += 1) limiter.fail(`client-${index}`)
  assert.equal(limiter.size, 3)
})

test('an existing client is still counted once the map is full', () => {
  const { limiter } = fixture({ maxClients: 2, limit: 3 })
  limiter.fail('a')
  limiter.fail('b')
  limiter.fail('c')
  assert.equal(limiter.size, 2)
  // The tracked clients keep working; only new keys are dropped.
  assert.equal(limiter.fail('a'), 0)
  assert.equal(limiter.fail('a'), 5000)
})

test('sweep keeps blocked and in-window records, drops the rest', () => {
  const { limiter, advance } = fixture({ limit: 3, windowMs: 10_000, blockMs: 60_000 })
  limiter.fail('blocked')
  limiter.fail('blocked')
  limiter.fail('blocked')
  limiter.fail('recent')
  advance(11_000)
  limiter.sweep()
  assert.ok(limiter.retryAfterMs('blocked') > 0)
  assert.equal(limiter.size, 1, 'the in-window record aged out, the block did not')
})
