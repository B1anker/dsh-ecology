/**
 * Persistent authorization records for GitHub identities.
 *
 * The file holds who may enter, never OAuth tokens. Integrity is enforced with
 * directory/file modes, symlink refusal, a strict schema, and an atomic rename
 * write — the same shape of care the password verifier env file already uses.
 *
 * @module @seaveyon/dsh-web-login/authorization
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type EnvLike, resolveDshHome } from './env-file.js'

/** Current on-disk schema version. */
export const AUTHORIZATION_SCHEMA_VERSION = 1

/** Soft upper bound on the authorization file size. */
export const MAX_AUTHORIZATION_BYTES = 256 * 1024

/** Soft upper bound on the recovery state file size. */
export const MAX_RECOVERY_BYTES = 4 * 1024

/** Roles the MVP understands. */
export type AuthRole = 'owner' | 'member'

/** Status values the MVP understands. */
export type AuthUserStatus = 'active' | 'disabled'

/** One authorized GitHub identity. */
export interface AuthorizedUser {
  githubUserId: number
  login: string
  role: AuthRole
  status: AuthUserStatus
  enrolledAt: string
  lastLoginAt?: string
}

/** The authorization document as stored on disk. */
export interface AuthorizationDocument {
  schemaVersion: number
  authzVersion: number
  users: AuthorizedUser[]
}

/** Lifecycle derived from the authorization document and recovery window. */
export type AuthLifecycle = 'bootstrap' | 'active' | 'recovery' | 'invalid'

/** A pending host-local recovery capability. */
export interface RecoveryRecord {
  tokenDigest: string
  createdAt: string
  expiresAt: string
}

/** Whether a thrown value is a Node system error carrying `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

/**
 * Default path of the GitHub authorization file.
 * @param env - environment used to resolve DSH home.
 * @returns absolute path.
 */
export function defaultAuthorizationPath(env: EnvLike = process.env): string {
  return join(resolveDshHome(env), 'auth', 'dsh-web-login', 'github-users.json')
}

/**
 * Default path of the host-local recovery state file.
 * @param env - environment used to resolve DSH home.
 * @returns absolute path.
 */
export function defaultRecoveryPath(env: EnvLike = process.env): string {
  return join(resolveDshHome(env), 'auth', 'dsh-web-login', 'recovery.json')
}

/**
 * Digest a recovery or invitation token for at-rest storage.
 * @param token - the raw token.
 * @returns hex-encoded SHA-256 digest.
 */
export function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Generate a recovery token and its digest.
 * @returns raw token (show once) and digest (persist).
 */
export function mintRecoveryToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, digest: digestToken(token) }
}

/**
 * Parse an ISO-8601 timestamp, rejecting non-strings and invalid values.
 * @param value - candidate timestamp.
 * @returns the Date when valid.
 */
function parseIso(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  if (date.toISOString() !== value) return undefined
  return date
}

/**
 * Validate a single authorized user record.
 * @param value - candidate user.
 * @returns the normalized user, or undefined when invalid.
 */
function parseUser(value: unknown): AuthorizedUser | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const githubUserId = record.githubUserId
  const login = record.login
  const role = record.role
  const status = record.status
  const enrolledAt = parseIso(record.enrolledAt)
  if (typeof githubUserId !== 'number' || !Number.isInteger(githubUserId) || githubUserId <= 0) {
    return undefined
  }
  if (typeof login !== 'string' || login === '' || login.length > 64) return undefined
  if (role !== 'owner' && role !== 'member') return undefined
  if (status !== 'active' && status !== 'disabled') return undefined
  if (enrolledAt === undefined) return undefined
  const user: AuthorizedUser = {
    githubUserId,
    login,
    role,
    status,
    enrolledAt: enrolledAt.toISOString(),
  }
  if (record.lastLoginAt !== undefined) {
    const lastLoginAt = parseIso(record.lastLoginAt)
    if (lastLoginAt === undefined) return undefined
    user.lastLoginAt = lastLoginAt.toISOString()
  }
  return user
}

/**
 * Parse and validate an authorization document.
 * @param raw - UTF-8 file contents.
 * @returns the document, or a reason it is invalid.
 */
export function parseAuthorizationDocument(
  raw: string,
): { ok: true; document: AuthorizationDocument } | { ok: false; reason: string } {
  if (Buffer.byteLength(raw, 'utf8') > MAX_AUTHORIZATION_BYTES) {
    return { ok: false, reason: 'authorization file exceeds size limit' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'authorization file is not JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'authorization file must be an object' }
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown authorization schemaVersion' }
  }
  if (
    typeof record.authzVersion !== 'number' ||
    !Number.isInteger(record.authzVersion) ||
    record.authzVersion < 1
  ) {
    return { ok: false, reason: 'authzVersion must be a positive integer' }
  }
  if (!Array.isArray(record.users)) {
    return { ok: false, reason: 'users must be an array' }
  }
  const users: AuthorizedUser[] = []
  const seen = new Set<number>()
  for (const entry of record.users) {
    const user = parseUser(entry)
    if (user === undefined) return { ok: false, reason: 'authorization user record is invalid' }
    if (seen.has(user.githubUserId)) {
      return { ok: false, reason: 'duplicate githubUserId in authorization file' }
    }
    seen.add(user.githubUserId)
    users.push(user)
  }
  const owners = users.filter((user) => user.role === 'owner' && user.status === 'active')
  if (users.length > 0 && owners.length === 0) {
    return { ok: false, reason: 'authorization file has users but no active owner' }
  }
  return {
    ok: true,
    document: {
      schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
      authzVersion: record.authzVersion,
      users,
    },
  }
}

/**
 * Derive the lifecycle state from an authorization document and optional recovery.
 *
 * @param document - parsed authorization document, or null when missing.
 * @param recovery - live recovery record, or null when absent/expired.
 * @param now - current time.
 * @returns the lifecycle label.
 */
export function resolveLifecycle(
  document: AuthorizationDocument | null,
  recovery: RecoveryRecord | null,
  now: Date = new Date(),
): AuthLifecycle {
  if (document !== null) {
    const owners = document.users.filter(
      (user) => user.role === 'owner' && user.status === 'active',
    )
    if (document.users.length > 0 && owners.length === 0) return 'invalid'
  }
  if (recovery !== null) {
    const expiresAt = parseIso(recovery.expiresAt)
    if (expiresAt !== undefined && expiresAt.getTime() > now.getTime()) return 'recovery'
  }
  if (document === null || document.users.length === 0) return 'bootstrap'
  return 'active'
}

/**
 * Find an active authorized user by GitHub id.
 * @param document - authorization document.
 * @param githubUserId - numeric GitHub id.
 * @returns the user when active, otherwise undefined.
 */
export function findActiveUser(
  document: AuthorizationDocument,
  githubUserId: number,
): AuthorizedUser | undefined {
  return document.users.find(
    (user) => user.githubUserId === githubUserId && user.status === 'active',
  )
}

/**
 * Ensure a directory exists at mode 0700 and is not a symlink.
 * @param path - directory path.
 */
async function ensurePrivateDir(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing symlink directory ${path}`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`dsh-web-login: authorization path parent is not a directory`)
    }
    await chmod(path, 0o700)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      await mkdir(path, { recursive: true, mode: 0o700 })
      await chmod(path, 0o700)
      return
    }
    throw error
  }
}

/**
 * Atomically write a JSON document at mode 0600, refusing symlinks.
 * @param path - destination file path.
 * @param value - JSON-serializable value.
 */
export async function writeSecureJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path))
  try {
    const existing = await lstat(path)
    if (existing.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing to write through symlink ${path}`)
    }
  } catch (error) {
    if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error
  }

  const directory = dirname(path)
  const tempDirectory = await mkdtemp(join(directory, '.tmp-'))
  const tempPath = join(tempDirectory, 'payload.json')
  try {
    const body = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(tempPath, body, { encoding: 'utf8', mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, path)
    await chmod(path, 0o600)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

/**
 * Read a secure JSON file, refusing symlinks and oversized payloads.
 * @param path - file path.
 * @param maxBytes - hard size limit.
 * @returns file contents, or null when absent.
 */
export async function readSecureText(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing to read symlink ${path}`)
    }
    if (!stats.isFile()) {
      throw new Error(`dsh-web-login: authorization path is not a regular file`)
    }
    if (stats.size > maxBytes) {
      throw new Error(`dsh-web-login: file exceeds size limit`)
    }
    const raw = await readFile(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new Error(`dsh-web-login: file exceeds size limit`)
    }
    return raw
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Read a secure text file synchronously for plugin startup.
 * @param path - file path.
 * @param maxBytes - hard size limit.
 * @returns file contents, or null when absent.
 */
export function readSecureTextSync(path: string, maxBytes: number): string | null {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing to read symlink ${path}`)
    }
    if (!stats.isFile()) {
      throw new Error(`dsh-web-login: authorization path is not a regular file`)
    }
    if (stats.size > maxBytes) {
      throw new Error(`dsh-web-login: file exceeds size limit`)
    }
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new Error(`dsh-web-login: file exceeds size limit`)
    }
    return raw
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Load the authorization document from disk.
 * @param path - authorization file path.
 * @returns the document, null when missing, or invalid with a reason.
 */
export async function loadAuthorizationDocument(
  path: string,
): Promise<{ ok: true; document: AuthorizationDocument | null } | { ok: false; reason: string }> {
  let raw: string | null
  try {
    raw = await readSecureText(path, MAX_AUTHORIZATION_BYTES)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'failed to read authorization file',
    }
  }
  if (raw === null) return { ok: true, document: null }
  const parsed = parseAuthorizationDocument(raw)
  if (!parsed.ok) return parsed
  return { ok: true, document: parsed.document }
}

/**
 * Synchronously load authorization + recovery and derive lifecycle.
 *
 * Cordis `apply()` is synchronous, so the initial gate state must be known
 * before the first request without turning startup into an async handshake.
 *
 * @param authorizationFile - path to github-users.json.
 * @param recoveryFile - path to recovery.json.
 * @param now - current time.
 */
export function loadAuthStartupState(
  authorizationFile: string,
  recoveryFile: string,
  now: Date = new Date(),
): {
  document: AuthorizationDocument | null
  lifecycle: AuthLifecycle
  error?: string
} {
  try {
    const raw = readSecureTextSync(authorizationFile, MAX_AUTHORIZATION_BYTES)
    let document: AuthorizationDocument | null = null
    if (raw !== null) {
      const parsed = parseAuthorizationDocument(raw)
      if (!parsed.ok) {
        return { document: null, lifecycle: 'invalid', error: parsed.reason }
      }
      document = parsed.document
    }
    let recovery = null
    try {
      const recoveryRaw = readSecureTextSync(recoveryFile, MAX_RECOVERY_BYTES)
      if (recoveryRaw !== null) {
        const record = parseRecoveryRecord(recoveryRaw)
        if (record !== undefined) {
          const expiresAt = new Date(record.expiresAt)
          if (expiresAt.getTime() > now.getTime()) recovery = record
        }
      }
    } catch (error) {
      return {
        document: null,
        lifecycle: 'invalid',
        error: error instanceof Error ? error.message : 'recovery state unreadable',
      }
    }
    return { document, lifecycle: resolveLifecycle(document, recovery, now) }
  } catch (error) {
    return {
      document: null,
      lifecycle: 'invalid',
      error: error instanceof Error ? error.message : 'authorization state unreadable',
    }
  }
}

/**
 * Persist an authorization document.
 * @param path - destination path.
 * @param document - document to write.
 */
export async function saveAuthorizationDocument(
  path: string,
  document: AuthorizationDocument,
): Promise<void> {
  await writeSecureJson(path, document)
}

/**
 * Create the first-owner authorization document.
 * @param user - owner identity from GitHub.
 * @returns a schemaVersion 1 document with authzVersion 1.
 */
export function createOwnerDocument(user: {
  githubUserId: number
  login: string
  enrolledAt?: string
}): AuthorizationDocument {
  const enrolledAt = user.enrolledAt ?? new Date().toISOString()
  return {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    authzVersion: 1,
    users: [
      {
        githubUserId: user.githubUserId,
        login: user.login,
        role: 'owner',
        status: 'active',
        enrolledAt,
        lastLoginAt: enrolledAt,
      },
    ],
  }
}

/**
 * Return a copy of the document with an updated lastLoginAt for one user.
 * @param document - current document.
 * @param githubUserId - user to touch.
 * @param at - login timestamp.
 * @returns a new document, or the original when the user is missing.
 */
export function touchLastLogin(
  document: AuthorizationDocument,
  githubUserId: number,
  at: string = new Date().toISOString(),
): AuthorizationDocument {
  return {
    ...document,
    users: document.users.map((user) =>
      user.githubUserId === githubUserId ? { ...user, lastLoginAt: at, login: user.login } : user,
    ),
  }
}

/**
 * Parse a recovery state file.
 * @param raw - UTF-8 contents.
 * @returns the record, or undefined when invalid.
 */
export function parseRecoveryRecord(raw: string): RecoveryRecord | undefined {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.tokenDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.tokenDigest)) {
    return undefined
  }
  const createdAt = parseIso(record.createdAt)
  const expiresAt = parseIso(record.expiresAt)
  if (createdAt === undefined || expiresAt === undefined) return undefined
  return {
    tokenDigest: record.tokenDigest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * Load a recovery record from disk.
 * @param path - recovery file path.
 * @returns the record, or null when absent/invalid/expired.
 */
export async function loadRecoveryRecord(
  path: string,
  now: Date = new Date(),
): Promise<RecoveryRecord | null> {
  const raw = await readSecureText(path, MAX_RECOVERY_BYTES)
  if (raw === null) return null
  const record = parseRecoveryRecord(raw)
  if (record === undefined) return null
  const expiresAt = new Date(record.expiresAt)
  if (expiresAt.getTime() <= now.getTime()) return null
  return record
}

/**
 * Persist a recovery record.
 * @param path - destination path.
 * @param record - recovery record.
 */
export async function saveRecoveryRecord(path: string, record: RecoveryRecord): Promise<void> {
  await writeSecureJson(path, record)
}

/**
 * Delete a recovery record after successful consumption or expiry.
 * @param path - recovery file path.
 */
export async function clearRecoveryRecord(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing to clear symlink ${path}`)
    }
    await rm(path, { force: true })
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return
    throw error
  }
}
