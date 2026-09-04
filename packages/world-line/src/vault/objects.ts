/**
 * Content-addressed object store (`world-line/vault/objects/<sha256>`).
 *
 * Objects are immutable by construction: the file name is the sha256 of the
 * bytes, writes are atomic, existing objects are never rewritten, and reads
 * verify the hash (a mismatch is an internal-invariant error — corrupt
 * store). Deduplication falls out of the addressing.
 */

import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { InvariantError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { sha256Hex } from '../fs/hash.js'
import { objectsDir } from '../fs/paths.js'

/** The object store root for one DSH home. */
export function objectRoot(home: string): string {
  return objectsDir(home)
}

/** Path of one object by its sha256. */
export function objectFilePath(home: string, sha256: string): string {
  return join(objectRoot(home), sha256)
}

/**
 * Store bytes if not already present. Returns the content hash and whether a
 * new object was written.
 */
export async function putObject(
  home: string,
  bytes: Uint8Array | string,
): Promise<{ sha256: string; stored: boolean }> {
  const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)
  const sha = sha256Hex(data)
  const target = objectFilePath(home, sha)
  if (await exists(target)) {
    return { sha256: sha, stored: false }
  }
  await writeFileAtomic(target, data, { mode: 0o600 })
  return { sha256: sha, stored: true }
}

/** Whether a file exists (close-on-read probe, no leaked handles). */
async function exists(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'r')
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Read an object's bytes and verify their hash. */
export async function readObject(home: string, sha256: string): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await readFile(objectFilePath(home, sha256))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvariantError(`content object ${sha256} is missing from the vault`)
    }
    throw error
  }
  const actual = sha256Hex(bytes)
  if (actual !== sha256) {
    throw new InvariantError(
      `content object ${sha256} failed its hash check (got ${actual}); vault is corrupt`,
    )
  }
  return bytes
}
