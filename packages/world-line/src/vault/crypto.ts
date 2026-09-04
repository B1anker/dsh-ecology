/**
 * Encrypted vault (WORLD-LINE-SPEC §5, Phase 4): secret-bearing files are
 * never persisted in plaintext. When a key service is available, each such
 * file is encrypted with AES-256-GCM into `vault/secrets/<snapshot-id>.bin`;
 * otherwise the platform degrades to the Phase 1 policy (record hash + reason,
 * persist nothing) — never a plaintext write.
 *
 * Key handling stays behind `KeyProvider`:
 *
 * - `keychainKeyProvider` stores one 256-bit key as a macOS Keychain generic
 *   password via the `security` CLI (service `dsh-world-line`, account
 *   `vault-secrets`). The key is created once with `add-generic-password`
 *   and read back with `find-generic-password`; every platform with no
 *   usable key service returns null from `getOrCreateKey` so callers take
 *   the safe-skip path.
 * - Tests inject an in-memory provider; a fake `security` binary on PATH
 *   exercises the Keychain adapter without touching a real keychain.
 */

import { execFile } from 'node:child_process'
import {
  type CipherGCMTypes,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** AES-256-GCM constants. */
export const SECRET_CIPHER: CipherGCMTypes = 'aes-256-gcm'
export const SECRET_KEY_BYTES = 32
export const SECRET_IV_BYTES = 12
export const SECRET_TAG_BYTES = 16
/** Keychain item identity (service/account of the generic password). */
export const KEYCHAIN_SERVICE = 'seaveyon.dsh-world-line'
export const KEYCHAIN_ACCOUNT_PREFIX = 'dsh-home:'
/** Envelope format written into `vault/secrets/<snapshot-id>.bin`. */
export const SECRET_BUNDLE_FORMAT_VERSION = 1
/** Format id recorded on the snapshot manifest (WORLD-LINE design §3.2). */
export const SECRET_BUNDLE_FORMAT = 'AES-256-GCM-v1'
/** Environment override carrying a 64-hex-char key (dev/CI seam). */
export const SECRET_KEY_ENV = 'WORLD_LINE_SECRET_KEY'
/** Set to \`1\` to skip the macOS Keychain attempt (CI/test isolation). */
export const DISABLE_KEYCHAIN_ENV = 'WORLD_LINE_DISABLE_KEYCHAIN'

/** One encrypted file inside a secret bundle. */
export interface SecretFileEntry {
  name: string
  size: number
  iv: string
  tag: string
}

/** The cleartext header of a secret bundle (never holds secret bytes). */
export interface SecretBundleHeader {
  formatVersion: number
  algorithm: string
  createdAt: string
  files: SecretFileEntry[]
}

/**
 * A source for the vault master key. `null` means "no secure key service on
 * this platform" — the caller must skip sensitive content, never fall back
 * to a plaintext store.
 */
export interface KeyProvider {
  /** `keychain`, `env`, or `none` — for diagnostics and messages. */
  readonly id: 'keychain' | 'env' | 'none'
  getOrCreateKey(): Promise<Buffer | null>
}

/**
 * Resolve the vault key provider (design §3.2 resolution order):
 * 1. `WORLD_LINE_SECRET_KEY` (64 hex chars) — dev/CI seam;
 * 2. macOS with a working `security` CLI — Keychain generic password
 *    (service `seaveyon.dsh-world-line`, account `dsh-home:<16-hex>` of the
 *    dsh home hash) created on first need;
 * 3. anything else — provider `none` returning null (safe skip).
 */
export function createKeyProvider(options: {
  env: NodeJS.ProcessEnv
  home: string
  /** Override the `security` binary (tests). */
  securityBinary?: string
}): KeyProvider {
  const fromEnv = options.env[SECRET_KEY_ENV]
  if (typeof fromEnv === 'string' && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    const key = Buffer.from(fromEnv, 'hex')
    return {
      id: 'env',
      async getOrCreateKey(): Promise<Buffer | null> {
        return key
      },
    }
  }
  if (process.platform === 'darwin' && options.env[DISABLE_KEYCHAIN_ENV] !== '1') {
    const account = `${KEYCHAIN_ACCOUNT_PREFIX}${createHash('sha256').update(options.home).digest('hex').slice(0, 16)}`
    return {
      id: 'keychain',
      getOrCreateKey: keychainKeyProvider({
        service: KEYCHAIN_SERVICE,
        account,
        binary: options.securityBinary ?? 'security',
      }).getOrCreateKey,
    }
  }
  return {
    id: 'none',
    async getOrCreateKey(): Promise<Buffer | null> {
      return null
    },
  }
}

/** In-memory provider for tests. */
export class MemoryKeyProvider implements KeyProvider {
  readonly id = 'none' as const
  private key: Buffer | null
  constructor(key: Buffer | null = null) {
    this.key = key
  }
  setKey(key: Buffer): void {
    this.key = key
  }
  async getOrCreateKey(): Promise<Buffer | null> {
    return this.key
  }
}

/**
 * macOS Keychain provider through the `security` CLI. Any failure to talk to
 * the keychain resolves to null (safe skip) instead of throwing — a broken
 * or absent key service must never force a plaintext fallback.
 */
export function keychainKeyProvider(
  options: {
    service?: string
    account?: string
    /** Override the `security` binary (tests). */
    binary?: string
    /** Fixed key for tests instead of random creation. */
    key?: Buffer
  } = {},
): KeyProvider {
  const service = options.service ?? KEYCHAIN_SERVICE
  const account = options.account ?? `${KEYCHAIN_ACCOUNT_PREFIX}default`
  const binary = options.binary ?? 'security'
  let createdKey: Buffer | null = null
  return {
    id: 'keychain',
    async getOrCreateKey(): Promise<Buffer | null> {
      try {
        const found = await execFileAsync(
          binary,
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          {
            encoding: 'utf8',
            timeout: 10_000,
          },
        )
        const key = parseKeyHex(found.stdout.trim())
        if (key !== null) return key
        // A non-empty answer that is not a valid key means the keychain item
        // is corrupt — fail closed rather than rotating the key under
        // previously encrypted bundles.
        if (found.stdout.trim() !== '') return null
      } catch {
        // Not found or keychain unavailable — fall through to creation attempt.
      }
      if (createdKey !== null) return createdKey
      const key = options.key ?? randomBytes(SECRET_KEY_BYTES)
      try {
        await execFileAsync(
          binary,
          ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('hex'), '-U'],
          { encoding: 'utf8', timeout: 10_000 },
        )
      } catch {
        return null
      }
      createdKey = key
      return key
    },
  }
}

function parseKeyHex(text: string): Buffer | null {
  if (!/^[0-9a-f]{64}$/.test(text)) return null
  const key = Buffer.from(text, 'hex')
  return key.byteLength === SECRET_KEY_BYTES ? key : null
}

/**
 * In-memory keychain-shim for tests that want Keychain CLI semantics
 * (find → add) without a real keychain. Not exported as a product path.
 */
export function fakeSecurityKeyProvider(key: Buffer, binary: string): KeyProvider {
  return keychainKeyProvider({ key, binary })
}

/** Encrypt one file chunk with AES-256-GCM. */
export function encryptChunk(
  key: Buffer,
  plaintext: Buffer,
): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = randomBytes(SECRET_IV_BYTES)
  const cipher = createCipheriv(SECRET_CIPHER, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv, tag, ciphertext }
}

/** Decrypt one file chunk; a tampered/mismatched key throws. */
export function decryptChunk(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv(SECRET_CIPHER, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Serialize a secret bundle: cleartext JSON header + concatenated ciphertexts. */
export function serializeSecretBundle(header: SecretBundleHeader, ciphertexts: Buffer[]): Buffer {
  const headerRaw = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')
  return Buffer.concat([headerRaw, ...ciphertexts])
}

/** Split a bundle into header text and the payload region after it. */
export function splitSecretBundle(bundle: Buffer): { header: SecretBundleHeader; payload: Buffer } {
  const newline = bundle.indexOf(0x0a)
  if (newline < 0) throw new Error('secret bundle has no header line')
  const header = JSON.parse(bundle.subarray(0, newline).toString('utf8')) as SecretBundleHeader
  if (
    header.formatVersion !== SECRET_BUNDLE_FORMAT_VERSION ||
    header.algorithm !== SECRET_CIPHER ||
    !Array.isArray(header.files)
  ) {
    throw new Error('secret bundle header is not a supported AES-256-GCM envelope')
  }
  return { header, payload: bundle.subarray(newline + 1) }
}

/** Walk the payload in file order and decrypt every entry. */
export function decryptSecretBundle(
  key: Buffer,
  bundle: Buffer,
): Array<{ name: string; plaintext: Buffer }> {
  const { header, payload } = splitSecretBundle(bundle)
  const out: Array<{ name: string; plaintext: Buffer }> = []
  let offset = 0
  for (const file of header.files) {
    const end = offset + file.size
    if (end > payload.byteLength) throw new Error(`secret bundle truncated at ${file.name}`)
    const ciphertext = payload.subarray(offset, end)
    const plaintext = decryptChunk(
      key,
      Buffer.from(file.iv, 'hex'),
      Buffer.from(file.tag, 'hex'),
      ciphertext,
    )
    out.push({ name: file.name, plaintext })
    offset = end
  }
  if (offset !== payload.byteLength) throw new Error('secret bundle has trailing bytes')
  return out
}
