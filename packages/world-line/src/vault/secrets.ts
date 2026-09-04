/**
 * Secret bundle persistence (`world-line/vault/secrets/<snapshot-id>.bin`):
 * capture (encrypt + write before the manifest lands) and snapshot restore
 * materialization (decrypt + verify digest). Secret bytes exist in memory
 * and in restore-lab profile files only — never in reports, stdout, diffs,
 * or plaintext vault objects.
 */

import { readFile } from 'node:fs/promises'
import { FileError } from '../domain/errors.js'
import { sha256Hex } from '../fs/hash.js'
import { secretBundlePath } from '../fs/paths.js'
import {
  decryptSecretBundle,
  encryptChunk,
  SECRET_BUNDLE_FORMAT,
  SECRET_BUNDLE_FORMAT_VERSION,
  SECRET_CIPHER,
  type SecretBundleHeader,
  serializeSecretBundle,
} from './crypto.js'

/** One captured secret file (name → plaintext bytes). */
export interface SecretSourceEntry {
  name: string
  bytes: Buffer
}

/** Encrypt a set of secret files into one bundle buffer. */
export function buildSecretBundle(
  key: Buffer,
  files: SecretSourceEntry[],
): { bundle: Buffer; sha256: string; entryCount: number } {
  const header: SecretBundleHeader = {
    formatVersion: SECRET_BUNDLE_FORMAT_VERSION,
    algorithm: SECRET_CIPHER,
    createdAt: new Date().toISOString(),
    files: [],
  }
  const ciphertexts: Buffer[] = []
  for (const entry of files) {
    const { iv, tag, ciphertext } = encryptChunk(key, entry.bytes)
    header.files.push({
      name: entry.name,
      size: ciphertext.byteLength,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
    })
    ciphertexts.push(ciphertext)
  }
  const bundle = serializeSecretBundle(header, ciphertexts)
  return { bundle, sha256: sha256Hex(bundle), entryCount: files.length }
}

/**
 * Read + decrypt every entry of a snapshot's secret bundle.
 * Throws FileError on a missing bundle, an unknown format, a digest
 * mismatch, or any AES-GCM failure (tamper / wrong key) — a restore must
 * fail closed rather than materialize garbage.
 */
export async function readSecretBundleEntries(
  home: string,
  snapshotId: string,
  key: Buffer,
  expectedSha256?: string,
): Promise<Map<string, Buffer>> {
  let bytes: Buffer
  try {
    bytes = await readFile(secretBundlePath(home, snapshotId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileError(
        `snapshot ${snapshotId} has no encrypted secret bundle under this home ` +
          `(its secret files were skipped, so it is not byte-restorable)`,
      )
    }
    throw new FileError(`cannot read the secret bundle of ${snapshotId}: ${String(error)}`)
  }
  if (expectedSha256 !== undefined && sha256Hex(bytes) !== expectedSha256) {
    throw new FileError(`secret bundle of ${snapshotId} fails its manifest digest`)
  }
  let entries: Array<{ name: string; plaintext: Buffer }>
  try {
    entries = decryptSecretBundle(key, bytes)
  } catch (error) {
    throw new FileError(
      `secret bundle of ${snapshotId} cannot be decrypted ` +
        `(wrong key or tampered content): ${String(error)}`,
    )
  }
  const map = new Map<string, Buffer>()
  for (const entry of entries) map.set(entry.name, entry.plaintext)
  return map
}

/** Digest facts recorded on the snapshot manifest. */
export interface SecretBundleFacts {
  format: string
  sha256: string
  size: number
  entryCount: number
}

/** Digest facts for a fresh bundle write (size from the buffer). */
export function secretBundleFacts(bundle: Buffer, entryCount: number): SecretBundleFacts {
  return {
    format: SECRET_BUNDLE_FORMAT,
    sha256: sha256Hex(bundle),
    size: bundle.byteLength,
    entryCount,
  }
}
