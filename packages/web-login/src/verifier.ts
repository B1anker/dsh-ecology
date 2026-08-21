/**
 * Password verifier: the one place that touches secret material.
 *
 * The stored form is `scrypt$<saltHex>$<keyHex>`, produced by the package's
 * `dsh-web-login-hash` command. Parsing is deliberately strict rather than
 * permissive: `Buffer.from(value, 'hex')` silently truncates at the first
 * invalid pair, so a corrupted verifier would otherwise become a *shorter*
 * verifier that still compares — a weaker secret that reports no error. Every
 * component is therefore checked for exact syntax and exact length, and the
 * check runs once at startup so a misconfigured deployment fails closed before
 * a single route is registered.
 *
 * @module @seaveyon/dsh-web-login/verifier
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * scrypt cost parameters. Shared by the generator and the verifier — changing
 * any of them invalidates every existing verifier, so they are frozen and
 * exported rather than duplicated at the call sites.
 */
export const SCRYPT = Object.freeze({
  keylen: 64,
  saltBytes: 16,
  cost: 16384,
  blockSize: 8,
  parallelization: 1,
  // 128 * cost * blockSize is 16 MiB of working memory; the ceiling is stated
  // explicitly so a future cost bump fails loudly here instead of at runtime.
  maxmem: 64 * 1024 * 1024,
})

/** Longest password accepted for hashing or verification, in UTF-8 bytes. */
export const MAX_PASSWORD_BYTES = 1024

/** A parsed verifier: the salt it was derived with and the key to match. */
export interface Verifier {
  salt: Buffer
  expected: Buffer
}

const PREFIX = 'scrypt'
const HEX = /^[0-9a-f]+$/

/**
 * Whether a string is lowercase hex of exactly `bytes` bytes.
 * @param value - candidate hex string.
 * @param bytes - required decoded length.
 * @returns true when the string decodes to exactly that many bytes.
 */
function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value)
}

/**
 * Parse a stored verifier into its salt and expected key.
 *
 * @param stored - the `scrypt$<saltHex>$<keyHex>` string.
 * @returns the decoded parts, or null when the string is not a valid verifier.
 */
export function parseVerifier(stored: unknown): Verifier | null {
  if (typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 3) return null
  const [prefix, saltHex, keyHex] = parts
  if (prefix !== PREFIX) return null
  if (!isHex(saltHex, SCRYPT.saltBytes)) return null
  if (!isHex(keyHex, SCRYPT.keylen)) return null
  return { salt: Buffer.from(saltHex, 'hex'), expected: Buffer.from(keyHex, 'hex') }
}

/**
 * Assert that a verifier is usable, with a message safe to log.
 *
 * The thrown text names the environment variable but never echoes its value:
 * startup errors are the most-copied lines in any bug report, and a verifier
 * pasted into an issue is a leaked credential.
 *
 * @param stored - the candidate verifier.
 * @param envName - variable the value came from, for the error message.
 * @returns the parsed verifier.
 * @throws when the value is missing or malformed.
 */
export function requireVerifier(stored: unknown, envName: string): Verifier {
  if (typeof stored !== 'string' || stored === '') {
    throw new Error(
      `dsh-web-login: ${envName} is unset — run \`npx dsh-web-login-hash\` to ` +
        'generate one, then restart dsh',
    )
  }
  const parsed = parseVerifier(stored)
  if (parsed === null) {
    throw new Error(
      `dsh-web-login: ${envName} is not a valid scrypt verifier — expected ` +
        `scrypt$<${SCRYPT.saltBytes * 2} hex chars>$<${SCRYPT.keylen * 2} hex chars>; ` +
        'regenerate it with `npx dsh-web-login-hash`',
    )
  }
  return parsed
}

/** The scrypt options every derivation here uses. */
const SCRYPT_OPTIONS = Object.freeze({
  N: SCRYPT.cost,
  r: SCRYPT.blockSize,
  p: SCRYPT.parallelization,
  maxmem: SCRYPT.maxmem,
})

/**
 * Reject a candidate that is too long to hash.
 *
 * An unauthenticated caller must not get to choose how much CPU a single
 * request costs, so the length check happens before the KDF rather than inside
 * it.
 *
 * @param password - the candidate.
 * @throws when the candidate exceeds {@link MAX_PASSWORD_BYTES}.
 */
function assertHashable(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error('dsh-web-login: password exceeds the maximum accepted length')
  }
}

/**
 * Derive the scrypt key for a candidate password.
 *
 * Asynchronous because this is the request path. `scryptSync` holds the thread
 * it runs on for the whole derivation — around 80 milliseconds at these
 * parameters — and in a Node process that thread is the event loop, so a
 * synchronous verification stalls every other request, WebSocket frame, and
 * timer in the dsh process, not just the login that caused it. The callback
 * form runs the same work on libuv's threadpool instead. How many may run
 * there at once is decided by {@link module:@seaveyon/dsh-web-login/kdf-gate},
 * because saturating that pool would starve every other consumer of it.
 *
 * @param password - the candidate, as supplied by a request.
 * @param salt - the verifier's salt.
 * @returns the derived key.
 * @throws when the candidate exceeds {@link MAX_PASSWORD_BYTES}.
 */
export function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  assertHashable(password)
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, SCRYPT_OPTIONS, (error, key) => {
      if (error !== null) reject(error)
      else resolve(key)
    })
  })
}

/**
 * Derive the scrypt key synchronously.
 *
 * Only for the `dsh-web-login-hash` command, which is a one-shot process with
 * nothing else to serve: there is no event loop worth yielding to, and the
 * synchronous form keeps the password in scope for a shorter time. Nothing on
 * the request path may call this.
 *
 * @param password - the password to hash.
 * @param salt - the salt to derive with.
 * @returns the derived key.
 * @throws when the password exceeds {@link MAX_PASSWORD_BYTES}.
 */
export function deriveKeySync(password: string, salt: Buffer): Buffer {
  assertHashable(password)
  return scryptSync(password, salt, SCRYPT.keylen, SCRYPT_OPTIONS)
}

/**
 * Format a fresh verifier for a password.
 * @param password - the password to hash.
 * @returns the `scrypt$<saltHex>$<keyHex>` string to store.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT.saltBytes)
  const key = deriveKeySync(password, salt)
  return `${PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * Compare a candidate password against a parsed verifier in constant time.
 *
 * Oversized and empty candidates are refused before the KDF runs, so a request
 * that cannot possibly match never reaches the expensive part. The candidate is
 * typed `unknown` because it arrives from a parsed form body, where a repeated
 * field or a missing one is a value this must simply refuse.
 *
 * @param candidate - password supplied by the request.
 * @param verifier - the parsed verifier from {@link requireVerifier}.
 * @returns whether the candidate matches.
 */
export async function verifyPassword(candidate: unknown, verifier: Verifier): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate === '') return false
  if (Buffer.byteLength(candidate, 'utf8') > MAX_PASSWORD_BYTES) return false
  const actual = await deriveKey(candidate, verifier.salt)
  return timingSafeEqual(actual, verifier.expected)
}
