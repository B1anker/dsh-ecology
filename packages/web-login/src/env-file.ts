/**
 * Reading and rewriting the dsh `.env` file that holds the verifier.
 *
 * The write path is the delicate one: this file usually holds unrelated dsh
 * settings, so the update has to be a surgical line replacement rather than a
 * rewrite, and it has to land atomically at mode 0600 — a verifier briefly
 * world-readable is a leaked credential, and a half-written `.env` is a dsh that
 * will not start.
 *
 * @module @seaveyon/dsh-web-login/env-file
 */

import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Conventional portable environment-variable identifier. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The subset of the environment this module reads. */
export type EnvLike = Record<string, string | undefined>

/**
 * Whether a value is safe to use as an environment variable name.
 * @param value - candidate name.
 * @returns true for portable shell/Node environment identifiers.
 */
export function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && ENV_NAME.test(value)
}

/**
 * Whether a thrown value is a Node system error carrying `code`.
 *
 * `catch` binds `unknown`, and the write path below has to distinguish "the
 * file is not there yet", which is the normal first run, from every other
 * failure, which must propagate. A cast would assert that distinction; this
 * checks it.
 *
 * @param error - the caught value.
 * @returns true when the value has a string `code` property.
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
}

/**
 * Resolve the dsh home directory the way dsh itself does.
 *
 * `DSH_HOME` wins when set and non-blank; otherwise `~/.dsh`. Matching that
 * exactly matters — writing the verifier somewhere dsh does not read is a
 * failure whose only symptom is "the password does not work".
 *
 * @param env - the environment to read, defaulting to the process environment.
 * @returns the absolute dsh home path.
 */
export function resolveDshHome(env: EnvLike = process.env): string {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Default path of the dsh environment file.
 * @param env - the environment to read.
 * @returns the absolute `.env` path.
 */
export function resolveEnvPath(env: EnvLike = process.env): string {
  return join(resolveDshHome(env), '.env')
}

/**
 * Replace one `KEY=value` assignment, preserving every other line.
 *
 * Commented-out and indented forms of the key are left alone: they are not what
 * the runtime reads, and silently deleting an operator's notes is worse than
 * leaving a stale comment behind.
 *
 * @param existing - current file contents, or the empty string.
 * @param key - variable name to set.
 * @param value - value to write.
 * @returns the new file contents, newline-terminated.
 */
export function upsertEnvAssignment(existing: unknown, key: unknown, value: unknown): string {
  if (typeof existing !== 'string') {
    throw new TypeError('dsh-web-login: existing environment content must be a string')
  }
  if (!isEnvName(key)) {
    throw new TypeError(
      'dsh-web-login: environment variable name must match [A-Za-z_][A-Za-z0-9_]*',
    )
  }
  if (typeof value !== 'string' || value.includes('\n') || value.includes('\r')) {
    throw new TypeError('dsh-web-login: environment variable value must be one line')
  }
  const prefix = `${key}=`
  const lines = existing === '' ? [] : existing.split(/\r?\n/)
  const kept = lines.filter((line) => !line.startsWith(prefix))
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()
  kept.push(`${prefix}${value}`)
  return `${kept.join('\n')}\n`
}

/** Where to write, which variable to set, and the value to store. */
export interface WriteEnvAssignmentOptions {
  path: string
  key: string
  value: string
}

/**
 * Write the verifier into the dsh `.env`, atomically and privately.
 *
 * A symlinked target is refused rather than followed: this runs as the user who
 * owns the dsh home, and following a link planted there would write a secret
 * wherever it points.
 *
 * @param options - `path`, `key`, and `value` to store.
 * @returns the path written.
 */
export async function writeEnvAssignment({
  path,
  key,
  value,
}: WriteEnvAssignmentOptions): Promise<string> {
  let existing = ''
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`dsh-web-login: refusing to write through a symlink at ${path}`)
    }
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
  }

  const next = upsertEnvAssignment(existing, key, value)
  // Keep the temporary file in a freshly-created, mode-0700 directory in the
  // target's parent. A predictable `.${key}.${pid}.tmp` path would let another
  // local process pre-place a symlink for writeFile to follow. This directory is
  // both unguessable and on the same filesystem, so the final rename remains an
  // atomic replacement rather than a copy observed half-written.
  const tempDir = await mkdtemp(join(dirname(path), `.${key}.`))
  const tempPath = join(tempDir, 'value')
  try {
    await writeFile(tempPath, next, { mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, path)
    await chmod(path, 0o600)
    return path
  } finally {
    // After a successful rename only the empty directory remains. On failure,
    // remove its private file too; cleanup never hides the original error.
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
