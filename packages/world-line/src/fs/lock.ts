/**
 * Exclusive per-profile writer locks (invariant 4: one writer per
 * `{dshHome, profile}`).
 *
 * Lock files live at `world-line/locks/<profile>.lock` and hold
 * `{ pid, host, startedAt, purpose }`, created with O_EXCL so two racers
 * cannot both win. Semantics:
 *
 * - Held by a live process on this host: `LockedError` — a live lock is never
 *   overridden (acceptance 9).
 * - Stale (holder dead, or from another host): refused unless the caller
 *   explicitly confirms by passing `breakStale: true`; the refusal message
 *   names the lock path so the user can also remove it by hand.
 *
 * Release deletes the file only when its token still matches (pid +
 * startedAt), so a release can never remove a successor's lock.
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

import { LockedError } from '../domain/errors.js'

/** What one lock record stores. */
export interface LockRecord {
  pid: number
  host: string
  startedAt: string
  purpose: string
}

/** Lock file payload including the release token. */
export interface LockFileContent extends LockRecord {
  token: string
}

/** An acquired lock; call `release()` when the critical section ends. */
export interface LockHandle {
  readonly record: LockFileContent
  /** Delete the lock file iff it still belongs to this acquisition. */
  release(): Promise<void>
}

/** Read a lock file's content, or `null` when absent/corrupt. */
export async function readLock(lockPath: string): Promise<LockFileContent | null> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockFileContent>
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null
    return parsed as LockFileContent
  } catch {
    // A corrupt lock file is a stale lock, not a crash: never auto-remove.
    return null
  }
}

/**
 * Whether a process id is alive on this host. `kill(pid, 0)` reports ESRCH
 * for a dead pid. Restricted runtimes (worker threads, sandboxed processes)
 * may answer with an unclassified error instead; in that ambiguous case the
 * process is treated as alive so a lock is never broken on a guess — that is
 * the fail-closed direction for lock safety.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

/** Whether a lock looks stale: holder dead, or recorded on another host. */
export function isStaleLock(content: LockFileContent | null, _now: Date): boolean {
  if (content === null) return false
  if (content.host !== hostname()) return true
  if (!isProcessAlive(content.pid)) return true
  // A live pid always means a live writer; an unparseable startedAt does not
  // make a running process stale.
  return false
}

/** The human-readable reason a lock is refused, for diagnostics. */
function refusalMessage(content: LockFileContent, lockPath: string, stale: boolean): string {
  const holder = `pid ${content.pid} on ${content.host} (${content.purpose ?? 'unknown purpose'})`
  const since = Number.isNaN(Date.parse(content.startedAt))
    ? ''
    : ` since ${new Date(content.startedAt).toISOString()}`
  if (stale) {
    return (
      `stale writer lock ${lockPath}: holder ${holder}${since} is no longer running; ` +
      `confirm removal with --break-stale-lock or delete the file by hand`
    )
  }
  return `writer lock held by ${holder}${since}: another world-line writer owns this profile`
}

/**
 * Acquire the exclusive lock for one profile. Throws {@link LockedError} when
 * held by a live writer, or when stale and `breakStale` was not requested.
 */
export async function acquireLock(options: {
  lockPath: string
  purpose: string
  breakStale?: boolean
  now?: Date
}): Promise<LockHandle> {
  const { lockPath, purpose, breakStale = false } = options
  const now = options.now ?? new Date()
  await mkdir(dirname(lockPath), { recursive: true })

  const existing = await readLock(lockPath)
  if (existing !== null) {
    const stale = isStaleLock(existing, now)
    if (!stale || !breakStale) {
      throw new LockedError(refusalMessage(existing, lockPath, stale))
    }
    // Confirmed stale takeover: clear the old file, then race for a fresh
    // O_EXCL creation below (a loser re-reads whatever won).
    await rm(lockPath, { force: true }).catch(() => {})
  }

  const record: LockFileContent = {
    pid: process.pid,
    host: hostname(),
    startedAt: now.toISOString(),
    purpose,
    token: `${process.pid}:${now.getTime()}:${Math.random().toString(36).slice(2, 10)}`,
  }
  try {
    const handle = await open(lockPath, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(record, null, 2))
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the race: someone else acquired between our read and our write.
      const winner = await readLock(lockPath)
      if (winner !== null) {
        throw new LockedError(refusalMessage(winner, lockPath, isStaleLock(winner, now)))
      }
      throw new LockedError(`writer lock ${lockPath} appeared and vanished mid-acquire`)
    }
    throw error
  }

  const acquired: LockHandle = {
    record,
    release: async () => {
      const current = await readLock(lockPath).catch(() => null)
      if (current !== null && current.token === record.token) {
        await rm(lockPath, { force: true }).catch(() => {})
      }
    },
  }
  return acquired
}
