import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, resolveConfig } from '../../src/config.js'

test('an absent config yields the documented defaults', () => {
  assert.deepEqual({ ...resolveConfig() }, { ...DEFAULTS })
  assert.deepEqual({ ...resolveConfig({}) }, { ...DEFAULTS })
})

test('the resolved config is frozen', () => {
  const options = resolveConfig()
  assert.ok(Object.isFrozen(options))
  assert.throws(() => { options.secureCookie = false }, TypeError)
})

test('unknown keys are rejected rather than ignored', () => {
  // A misspelled security setting that appears to have been accepted is worse
  // than a startup failure: the deployment then runs with a default the
  // operator believes they changed.
  assert.throws(() => resolveConfig({ sessionTtlMS: 1000 }), /unknown config key\(s\): sessionTtlMS/)
  assert.throws(() => resolveConfig({ secure: true, ttl: 1 }), /secure, ttl/)
})

test('a non-object config is rejected', () => {
  for (const bad of [null, 'x', 42, true]) {
    assert.throws(() => resolveConfig(bad), TypeError)
  }
})

test('string settings must be non-empty strings', () => {
  for (const key of ['passwordHashEnv', 'clientIpHeader', 'title']) {
    assert.throws(() => resolveConfig({ [key]: '' }), TypeError)
    assert.throws(() => resolveConfig({ [key]: 42 }), TypeError)
  }
})

test('clientIpHeader is lowercased to match Node header keys', () => {
  assert.equal(resolveConfig({ clientIpHeader: 'X-Real-IP' }).clientIpHeader, 'x-real-ip')
})

test('an over-long title is rejected', () => {
  assert.ok(resolveConfig({ title: 'a'.repeat(120) }))
  assert.throws(() => resolveConfig({ title: 'a'.repeat(121) }), /at most 120 characters/)
})

test('boolean settings reject truthy non-booleans', () => {
  for (const key of ['secureCookie', 'trustProxy']) {
    assert.throws(() => resolveConfig({ [key]: 'true' }), TypeError)
    assert.throws(() => resolveConfig({ [key]: 1 }), TypeError)
  }
})

test('numeric settings must be integers', () => {
  assert.throws(() => resolveConfig({ maxSessions: 1.5 }), TypeError)
  assert.throws(() => resolveConfig({ maxSessions: '10' }), TypeError)
  assert.throws(() => resolveConfig({ maxSessions: NaN }), TypeError)
})

test('numeric settings are range-checked at both ends', () => {
  // These bounds decide how much memory an unauthenticated caller can make the
  // process allocate, so zero and negative values must not be accepted.
  const cases = [
    ['sessionTtlMs', 59_999, 365 * 24 * 60 * 60 * 1000 + 1],
    ['maxBodyBytes', 63, 1024 * 1024 + 1],
    ['maxSessions', 0, 1_000_001],
    ['attemptLimit', 0, 1001],
    ['attemptWindowMs', 999, 24 * 60 * 60 * 1000 + 1],
    ['blockMs', 999, 24 * 60 * 60 * 1000 + 1],
    ['maxAttemptClients', 0, 1_000_001],
    ['sweepIntervalMs', 999, 60 * 60 * 1000 + 1],
  ]
  for (const [key, tooLow, tooHigh] of cases) {
    assert.throws(() => resolveConfig({ [key]: tooLow }), RangeError, `${key} low`)
    assert.throws(() => resolveConfig({ [key]: tooHigh }), RangeError, `${key} high`)
    assert.throws(() => resolveConfig({ [key]: -1 }), RangeError, `${key} negative`)
  }
})

test('valid overrides are carried through', () => {
  const options = resolveConfig({
    title: 'My Shell',
    passwordHashEnv: 'MY_HASH',
    secureCookie: false,
    trustProxy: true,
    maxSessions: 5,
  })
  assert.equal(options.title, 'My Shell')
  assert.equal(options.passwordHashEnv, 'MY_HASH')
  assert.equal(options.secureCookie, false)
  assert.equal(options.trustProxy, true)
  assert.equal(options.maxSessions, 5)
  assert.equal(options.attemptLimit, DEFAULTS.attemptLimit, 'untouched keys keep their default')
})

test('passwordHashEnv must be a portable environment variable name', () => {
  assert.ok(resolveConfig({ passwordHashEnv: '_HASH_2' }))
  for (const value of ['1HASH', 'HASH-NAME', 'HASH NAME', 'HASH\nINJECTED']) {
    assert.throws(() => resolveConfig({ passwordHashEnv: value }), /valid environment variable name/)
  }
})
