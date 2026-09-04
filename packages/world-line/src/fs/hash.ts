/**
 * Content hashing (sha256) shared by receipts, the object store, and local
 * plugin content hashes. Object ids and receipt trees are always hex sha256.
 */

import { createHash } from 'node:crypto'

/** Hex sha256 of one buffer. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
