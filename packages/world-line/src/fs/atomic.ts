/**
 * Atomic file writes (invariant 5's primitive): write to a sibling temp file,
 * fsync it, rename over the target, and best-effort fsync the parent
 * directory so the rename itself survives a crash. Every vault mutation
 * (objects, manifests, state, locks) goes through here or the lock module.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Best-effort directory fsync; a no-op where the platform forbids it. */
export async function fsyncDir(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unsupported on some filesystems (and always on
    // Windows); the write itself already went through rename.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Write `data` to `file` atomically: unique sibling temp file, write, fsync,
 * rename. `mode` applies to the temp file before rename (best effort).
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const tmp = join(
    directory,
    `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  )
  try {
    const handle = await open(tmp, 'wx', options.mode ?? 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.mode !== undefined) {
      await chmod(tmp, options.mode).catch(() => {})
    }
    await rename(tmp, file)
    await fsyncDir(directory)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
