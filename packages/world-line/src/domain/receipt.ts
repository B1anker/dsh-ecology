/**
 * Profile receipts (invariant 1 & promotion conflict detection): a
 * deterministic digest over the whitelisted composition files of one profile.
 *
 * The receipt hashes exactly the managed files (manifest, lockfile, workspace
 * settings, user patch layer) that promotion will copy — never `node_modules`
 * and never the derived root config, which DSH rewrites on every boot. The
 * receipt *tree* is the sha256 of a canonical JSON object mapping relative
 * file names to their sha256, so two receipts compare by string equality.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sha256Hex } from '../fs/hash.js'
import { FileError } from './errors.js'

/** A receipt over a profile's managed files. */
export interface ProfileReceipt {
  /** Hash algorithm of every leaf. */
  algo: 'sha256'
  /** Relative managed file name → leaf sha256, sorted by name. */
  files: Record<string, string>
  /** sha256 over the canonical JSON of `files`. */
  tree: string
}

/** Build a receipt from already-computed leaf hashes (canonical ordering). */
export function receiptFromHashes(files: Record<string, string>): ProfileReceipt {
  const sorted: Record<string, string> = {}
  for (const name of Object.keys(files).sort()) {
    const hash = files[name]
    if (hash !== undefined) sorted[name] = hash
  }
  return {
    algo: 'sha256',
    files: sorted,
    tree: sha256Hex(JSON.stringify(sorted)),
  }
}

/** Compute a receipt over a list of present managed files. */
export async function computeReceipt(options: {
  profileDir: string
  /** Relative paths (no separators needed — flat profile files). */
  fileNames: readonly string[]
}): Promise<ProfileReceipt> {
  const { profileDir } = options
  const files: Record<string, string> = {}
  for (const name of options.fileNames) {
    let bytes: Buffer
    try {
      bytes = await readFile(join(profileDir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileError(`receipt input ${name} missing from profile ${profileDir}`)
      }
      throw new FileError(`failed to read ${join(profileDir, name)}`)
    }
    files[name] = sha256Hex(bytes)
  }
  return receiptFromHashes(files)
}
