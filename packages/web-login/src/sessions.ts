/**
 * Bounded session store with optional private persistence.
 *
 * Sessions are opaque random ids mapped to an expiry and a principal. They may
 * be persisted in a private JSON file so normal restarts retain login.
 *
 * When GitHub OAuth is enabled, each session carries a principal so revocation
 * can target a GitHub user and authorization-version checks can reject stale
 * cookies after an authz file change.
 *
 * @module @seaveyon/dsh-web-login/sessions
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Bytes of entropy per session id. */
const ID_BYTES = 32
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/
const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024
const SESSION_SCHEMA_VERSION = 2

/** A clock, injectable so tests can advance time without waiting for it. */
export type Clock = () => number

/** Who a live session represents. */
export interface SessionPrincipal {
  provider: 'password' | 'password-bootstrap' | 'github' | 'recovery'
  githubUserId?: number
  githubLogin?: string
  role: 'owner' | 'member'
  authzVersion: number
}

/** A live session as the store holds it. */
export interface SessionRecord {
  expiresAt: number
  principal: SessionPrincipal
}

/* v8 ignore start -- exercised through the hostile persistent-file boundary */
function parsePrincipal(value: unknown): SessionPrincipal | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['provider', 'role', 'authzVersion', 'githubUserId', 'githubLogin'].includes(key),
    )
  )
    return undefined
  const githubUserId = record.githubUserId
  const githubLogin = record.githubLogin
  if (
    (record.provider !== 'password' &&
      record.provider !== 'password-bootstrap' &&
      record.provider !== 'github' &&
      record.provider !== 'recovery') ||
    (record.role !== 'owner' && record.role !== 'member') ||
    typeof record.authzVersion !== 'number' ||
    !Number.isInteger(record.authzVersion) ||
    record.authzVersion < 0 ||
    (githubUserId !== undefined &&
      (typeof githubUserId !== 'number' || !Number.isInteger(githubUserId) || githubUserId <= 0)) ||
    (githubLogin !== undefined && (typeof githubLogin !== 'string' || githubLogin.length > 64))
  )
    return undefined
  if (record.provider === 'github' && (githubUserId === undefined || githubLogin === undefined))
    return undefined
  if (record.provider !== 'github' && (githubUserId !== undefined || githubLogin !== undefined))
    return undefined
  return {
    provider: record.provider,
    role: record.role,
    authzVersion: record.authzVersion as number,
    ...(githubUserId === undefined ? {} : { githubUserId }),
    ...(githubLogin === undefined ? {} : { githubLogin }),
  }
}
/* v8 ignore stop */

/** Construction options for {@link createSessionStore}. */
export interface SessionStoreOptions {
  ttlMs: number
  maxSessions: number
  now?: Clock
  persistentFile?: string
  /** Non-secret verifier fingerprint; a change invalidates restored sessions. */
  binding?: string
}

/** The operations a session store exposes. */
export interface SessionStore {
  /** Mint a session, or return null when the store is full. */
  open: (principal: SessionPrincipal) => string | null
  /** Return a still-valid session record, or undefined. */
  get: (id: unknown) => SessionRecord | undefined
  /** Whether an id names a live session. */
  isLive: (id: unknown) => boolean
  /** Revoke a session; a missing id is a no-op. */
  revoke: (id: unknown) => void
  /** Revoke every session for a GitHub user id. */
  revokePrincipal: (githubUserId: number) => number
  /** Revoke every session. */
  revokeAll: () => void
  /** Drop expired sessions. */
  sweep: () => void
  /** The number of sessions currently held, expired ones included. */
  readonly size: number
}

/**
 * Create a session store.
 *
 * @param options - `ttlMs`, `maxSessions`, and an injectable `now` for tests.
 * @returns the store's operations.
 */
export function createSessionStore({
  ttlMs,
  maxSessions,
  now = Date.now,
  persistentFile,
  binding = '',
}: SessionStoreOptions): SessionStore {
  /** Session id -> record. */
  const sessions = new Map<string, SessionRecord>()
  /* v8 ignore start -- filesystem failure and symlink defences need hostile local setup */
  const persist = (): void => {
    if (persistentFile === undefined) return
    mkdirSync(dirname(persistentFile), { recursive: true, mode: 0o700 })
    const directory = lstatSync(dirname(persistentFile))
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error(`dsh-web-login: invalid session parent ${dirname(persistentFile)}`)
    }
    chmodSync(dirname(persistentFile), 0o700)
    try {
      if (lstatSync(persistentFile).isSymbolicLink())
        throw new Error(`dsh-web-login: refusing symlink ${persistentFile}`)
    } catch (error) {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'))
        throw error
    }
    const temp = join(dirname(persistentFile), `.sessions-${randomBytes(12).toString('hex')}`)
    try {
      writeFileSync(
        temp,
        JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, binding, sessions: [...sessions] }),
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        },
      )
      chmodSync(temp, 0o600)
      renameSync(temp, persistentFile)
      chmodSync(persistentFile, 0o600)
    } finally {
      rmSync(temp, { force: true })
    }
  }
  if (persistentFile !== undefined) {
    try {
      const stats = lstatSync(persistentFile)
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_SESSION_FILE_BYTES)
        throw new Error(`dsh-web-login: refusing symlink ${persistentFile}`)
      const raw = readFileSync(persistentFile, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_SESSION_FILE_BYTES)
        throw new Error('session store exceeds size limit')
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid session store')
      const values = parsed as { schemaVersion?: unknown; binding?: unknown; sessions?: unknown }
      const legacy = values.schemaVersion === 1 && values.binding === undefined
      if (
        Object.keys(parsed).some(
          (key) => !['schemaVersion', 'binding', 'sessions'].includes(key),
        ) ||
        (!legacy && values.schemaVersion !== SESSION_SCHEMA_VERSION) ||
        (!legacy && typeof values.binding !== 'string') ||
        !Array.isArray(values.sessions) ||
        values.sessions.length > maxSessions
      )
        throw new Error('invalid session store')
      for (const entry of values.sessions) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          !SESSION_ID.test(entry[0])
        )
          throw new Error('invalid session record')
        const record = entry[1] as SessionRecord
        if (
          record === null ||
          typeof record !== 'object' ||
          Object.keys(record).some((key) => key !== 'expiresAt' && key !== 'principal') ||
          typeof record?.expiresAt !== 'number' ||
          !Number.isFinite(record.expiresAt) ||
          parsePrincipal(record.principal) === undefined
        )
          throw new Error('invalid session record')
        if (!legacy && values.binding === binding && record.expiresAt > now())
          sessions.set(entry[0], {
            expiresAt: record.expiresAt,
            principal: parsePrincipal(record.principal) as SessionPrincipal,
          })
      }
      if (sessions.size > maxSessions) throw new Error('session store exceeds maxSessions')
      persist()
    } catch (error) {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'))
        throw new Error(
          `dsh-web-login: could not load persistent sessions: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
    }
  }

  /* v8 ignore stop */

  /** Drop expired ids so a long-lived process does not accumulate them. */
  const sweep = (): void => {
    const cutoff = now()
    for (const [id, record] of sessions) {
      if (record.expiresAt <= cutoff) sessions.delete(id)
    }
    persist()
  }

  /**
   * Look up a live session, dropping it when expired.
   * @param id - candidate session id.
   * @returns the live record, or undefined.
   */
  const get = (id: unknown): SessionRecord | undefined => {
    if (typeof id !== 'string' || id === '') return undefined
    const record = sessions.get(id)
    if (record === undefined) return undefined
    if (record.expiresAt <= now()) {
      sessions.delete(id)
      persist()
      return undefined
    }
    return record
  }

  return {
    /**
     * Mint a session.
     *
     * At capacity the store refuses rather than evicting the oldest live
     * session: silently signing an active operator out to make room for an
     * unauthenticated flood would turn a resource limit into a denial of
     * service against the legitimate user.
     *
     * @param principal - identity attached to the session.
     * @returns the new session id, or null when the store is full.
     */
    open(principal) {
      sweep()
      if (sessions.size >= maxSessions) return null
      const id = randomBytes(ID_BYTES).toString('base64url')
      sessions.set(id, {
        expiresAt: now() + ttlMs,
        principal: Object.freeze({ ...principal }),
      })
      persist()
      return id
    },

    get,

    /**
     * Whether an id names a live session; expired ids are dropped on lookup.
     *
     * Accepts `unknown` because the id arrives from a cookie header, where it
     * may be absent or malformed. Narrowing here keeps the check in one place
     * instead of at every call site.
     *
     * @param id - candidate session id.
     * @returns true when the session is live.
     */
    isLive(id) {
      return get(id) !== undefined
    },

    /**
     * Revoke a session.
     * @param id - session id to drop; a missing id is a no-op.
     */
    revoke(id) {
      if (typeof id === 'string') sessions.delete(id)
      persist()
    },

    /**
     * Revoke every session belonging to a GitHub user.
     * @param githubUserId - numeric GitHub id.
     * @returns how many sessions were removed.
     */
    revokePrincipal(githubUserId) {
      let removed = 0
      for (const [id, record] of sessions) {
        if (record.principal.githubUserId === githubUserId) {
          sessions.delete(id)
          removed += 1
        }
      }
      persist()
      return removed
    },

    /** Drop every session. Used when the authorization file is replaced. */
    revokeAll() {
      sessions.clear()
      persist()
    },

    /** Drop expired sessions. Exposed for the periodic sweep and for tests. */
    sweep,

    /** @returns the number of sessions currently held, expired ones included. */
    get size() {
      return sessions.size
    },
  }
}

/** Principal used by the classic shared-password mode. */
export const PASSWORD_PRINCIPAL: SessionPrincipal = Object.freeze({
  provider: 'password',
  role: 'owner',
  authzVersion: 0,
})
