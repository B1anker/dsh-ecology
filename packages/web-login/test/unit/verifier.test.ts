import { expect, test } from '@rstest/core'
import {
  deriveKey,
  hashPassword,
  MAX_PASSWORD_BYTES,
  parseVerifier,
  requireVerifier,
  SCRYPT,
  verifyPassword,
} from '../../src/verifier.js'

test('hashPassword produces a verifier that round-trips', () => {
  const stored = hashPassword('correct horse battery')
  const parsed = requireVerifier(stored, 'LOGIN_PASSWORD_HASH')
  expect(verifyPassword('correct horse battery', parsed)).toBe(true)
  expect(verifyPassword('wrong', parsed)).toBe(false)
})

test('each verifier uses a fresh salt', () => {
  expect(hashPassword('same password')).not.toBe(hashPassword('same password'))
})

test('parseVerifier rejects malformed input', () => {
  const salt = 'a'.repeat(SCRYPT.saltBytes * 2)
  const key = 'b'.repeat(SCRYPT.keylen * 2)
  // `parseVerifier` takes `unknown` because its argument is an environment
  // variable, which is absent or arbitrary far more often than it is a verifier.
  for (const stored of [
    undefined,
    null,
    42,
    '',
    'scrypt',
    `scrypt$${salt}`,
    `bcrypt$${salt}$${key}`,
    `scrypt$${salt}$${key}$extra`,
    // Truncated hex: Buffer.from would silently accept a shorter key, which
    // would mean a weaker secret that still verifies.
    `scrypt$${salt}$${'b'.repeat(SCRYPT.keylen * 2 - 2)}`,
    `scrypt$${'a'.repeat(SCRYPT.saltBytes * 2 - 2)}$${key}`,
    // Non-hex and uppercase hex are both refused rather than coerced.
    `scrypt$${'z'.repeat(SCRYPT.saltBytes * 2)}$${key}`,
    `scrypt$${salt.toUpperCase()}$${key}`,
  ]) {
    expect(parseVerifier(stored), `expected null for ${String(stored).slice(0, 40)}`).toBeNull()
  }
})

test('requireVerifier names the variable but never echoes its value', () => {
  const secret = hashPassword('a real password')

  expect(() => requireVerifier(undefined, 'MY_VAR')).toThrow(/MY_VAR/)
  expect(() => requireVerifier(undefined, 'MY_VAR')).toThrow(/unset/)

  // The failure message is the most-copied line in any bug report about this
  // package, so it must name the variable and nothing that is inside it.
  let thrown: unknown
  try {
    requireVerifier(`${secret}garbage`, 'MY_VAR')
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'a malformed verifier must be refused').toBeInstanceOf(Error)
  const message = (thrown as Error).message
  expect(message).toMatch(/MY_VAR/)
  expect(message.includes(secret), 'the error must not contain the verifier').toBe(false)
})

test('verifyPassword refuses an oversized candidate before hashing', () => {
  const parsed = requireVerifier(hashPassword('short'), 'LOGIN_PASSWORD_HASH')
  const huge = 'x'.repeat(MAX_PASSWORD_BYTES + 1)
  expect(verifyPassword(huge, parsed)).toBe(false)
  // scrypt at these parameters costs 16 MiB per call; the cap is what stops an
  // unauthenticated POST from choosing that cost.
  expect(() => deriveKey(huge, parsed.salt)).toThrow(/maximum accepted length/)
})

test('verifyPassword rejects empty and non-string candidates', () => {
  const parsed = requireVerifier(hashPassword('something'), 'LOGIN_PASSWORD_HASH')
  // The candidate arrives from a URL-encoded form body, so a missing field, a
  // repeated field, and a field sent as an object all reach here.
  for (const candidate of ['', undefined, null, 0, {}]) {
    expect(verifyPassword(candidate, parsed), JSON.stringify(candidate)).toBe(false)
  }
})

test('scrypt parameters are pinned', () => {
  // Changing any of these invalidates every stored verifier, so a change should
  // have to break this test deliberately.
  expect({ ...SCRYPT }).toEqual({
    keylen: 64,
    saltBytes: 16,
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
  })
})
