/**
 * Same-filesystem transactional file swap (WORLD-LINE-SPEC §4.5/§7.3-4):
 *
 *   staging dir inside the profile dir → fsynced candidate files → per-file
 *   rename dance (managed file to backup, candidate into place) → directory
 *   fsync. Any failure mid-dance rolls every already-moved file back before
 *   throwing, so the official profile is either fully replaced or untouched.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** fsync one regular file after writing it. */
export async function writeFileSynced(file: string, data: Buffer | string): Promise<void> {
  const handle = await open(file, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** fsync a directory (rename durability on POSIX). */
export async function syncDir(dir: string): Promise<void> {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is not available everywhere; rename ordering still holds.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Load every file of a profile dir whose name matches (whitelist subset). */
export async function existingManagedFiles(
  profileDir: string,
  names: readonly string[],
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(profileDir)
  } catch {
    return []
  }
  const wanted = new Set(names)
  return entries.filter((entry) => wanted.has(entry)).sort()
}

export interface SwapResult {
  applied: string[]
  rolledBack: boolean
}

/**
 * Atomically replace managed files in `profileDir` from `sourceOf(name)`
 * buffers. `sourceOf` may resolve `null` to mean *delete* that managed file
 * (rollback removes files a promote introduced). `profileDir` must exist.
 * Throws after rolling back on failure.
 */
export async function transactionalReplaceFiles(
  profileDir: string,
  names: readonly string[],
  sourceOf: (name: string) => Promise<Buffer | string | null>,
): Promise<SwapResult> {
  const applied: string[] = []
  const token = randomBytes(6).toString('hex')
  const staging = join(profileDir, `.wl-staging-${token}`)
  const backup = join(staging, 'backup')
  await mkdir(staging, { recursive: true })
  await mkdir(backup, { recursive: true })
  try {
    const present: string[] = []
    for (const name of names) {
      const content = await sourceOf(name)
      if (content === null) continue
      present.push(name)
      await writeFileSynced(join(staging, name), content)
    }
    await syncDir(staging)
    // Rename dance: managed file -> backup, candidate -> managed.
    for (const name of names) {
      const hadContent = present.includes(name)
      await rename(join(profileDir, name), join(backup, name)).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw error
      })
      if (hadContent) {
        await rename(join(staging, name), join(profileDir, name))
      }
      applied.push(name)
    }
    await syncDir(profileDir)
    await rm(staging, { recursive: true, force: true })
    return { applied, rolledBack: false }
  } catch (error) {
    // Roll back in reverse order; files never renamed stay untouched.
    for (const name of applied.reverse()) {
      await rename(join(profileDir, name), join(staging, name)).catch(() => {})
    }
    for (const name of names) {
      await rename(join(backup, name), join(profileDir, name)).catch(() => {})
    }
    await syncDir(profileDir).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`managed-file swap failed and was rolled back: ${message}`)
    wrapped.cause = error
    throw wrapped
  }
}
