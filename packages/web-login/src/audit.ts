import { appendFileSync, chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

export type AuditEvent =
  | 'login_succeeded'
  | 'login_failed'
  | 'login_throttled'
  | 'logout'
  | 'session_capacity_reached'
  | 'authorization_changed'
  | 'recovery_used'
  | 'sessions_revoked_all'

export interface SecurityAudit {
  record(event: AuditEvent, details?: Record<string, string | number | boolean | null>): void
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function inspectAuditFile(path: string): ReturnType<typeof lstatSync> | undefined {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error(`dsh-web-login: audit path is not a regular file: ${path}`)
  return stats
}

function rotateIfFull(path: string, maxBytes: number): void {
  const stats = inspectAuditFile(path)
  if (!stats || stats.size < maxBytes) return
  rmSync(`${path}.1`, { force: true })
  renameSync(path, `${path}.1`)
}

export function createSecurityAudit(
  path: string,
  now: () => Date = () => new Date(),
  onError: (error: unknown) => void = () => {},
  maxBytes = 5 * 1024 * 1024,
): SecurityAudit {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path))
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error(`dsh-web-login: invalid audit parent ${dirname(path)}`)
  chmodSync(dirname(path), 0o700)
  inspectAuditFile(path)
  return {
    record(event, details = {}) {
      try {
        rotateIfFull(path, maxBytes)
        appendFileSync(
          path,
          `${JSON.stringify({ ...details, timestamp: now().toISOString(), event })}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'a' },
        )
        chmodSync(path, 0o600)
      } catch (error) {
        onError(error)
      }
    },
  }
}
