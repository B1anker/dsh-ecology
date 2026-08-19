import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  assert.equal(verifyPassword('correct horse battery', parsed), true)
  assert.equal(verifyPassword('wrong', parsed), false)
})

test('each verifier uses a fresh salt', () => {
  assert.notEqual(hashPassword('same password'), hashPassword('same password'))
})

test('parseVerifier rejects malformed input', () => {
  const salt = 'a'.repeat(SCRYPT.saltBytes * 2)
  const key = 'b'.repeat(SCRYPT.keylen * 2)
  for (const bad of [
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
    assert.equal(parseVerifier(bad), null, `expected null for ${String(bad).slice(0, 40)}`)
  }
})

test('requireVerifier names the variable but never echoes its value', () => {
  const secret = hashPassword('a real password')
  assert.throws(
    () => requireVerifier(undefined, 'MY_VAR'),
    (error) => error.message.includes('MY_VAR') && error.message.includes('unset'),
  )
  assert.throws(
    () => requireVerifier(`${secret}garbage`, 'MY_VAR'),
    (error) => {
      assert.ok(error.message.includes('MY_VAR'))
      assert.ok(!error.message.includes(secret), 'error must not contain the verifier')
      return true
    },
  )
})

test('verifyPassword refuses an oversized candidate before hashing', () => {
  const parsed = requireVerifier(hashPassword('short'), 'LOGIN_PASSWORD_HASH')
  const huge = 'x'.repeat(MAX_PASSWORD_BYTES + 1)
  assert.equal(verifyPassword(huge, parsed), false)
  assert.throws(() => deriveKey(huge, parsed.salt), /maximum accepted length/)
})

test('verifyPassword rejects empty and non-string candidates', () => {
  const parsed = requireVerifier(hashPassword('something'), 'LOGIN_PASSWORD_HASH')
  for (const bad of ['', undefined, null, 0, {}]) {
    assert.equal(verifyPassword(bad, parsed), false)
  }
})

test('scrypt parameters are pinned', () => {
  // Changing any of these invalidates every stored verifier, so a change should
  // have to break this test deliberately.
  assert.deepEqual({ ...SCRYPT }, {
    keylen: 64,
    saltBytes: 16,
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
    maxmem: 64 * 1024 * 1024,
  })
})
