/**
 * Path resolution for the world-line store and DSH homes.
 *
 * The DSH home precedence mirrors the host's own `dsh-home-paths` contract
 * (verified against `@deepseek-ai/dsh-home-paths` 0.1.2-rc.1, recorded in
 * docs/compatibility.md): an explicit path first, then `$DSH_HOME` (blank and
 * whitespace-only values treated as unset), then `~/.dsh`. The CLI's
 * `--dsh-home` option is the explicit path.
 *
 * Profile-name validation mirrors the host's `resolveProfileDir`: reject
 * empty names, path separators, `.`/`..`, and `node_modules`.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { UsageError } from '../domain/errors.js'

/** Default DSH home directory name, matching the host (`~/.dsh`). */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Environment variable the host uses to override the DSH home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Names the host forbids as profile names (from its `resolveProfileDir`). */
const FORBIDDEN_PROFILE_NAMES = new Set(['', '.', '..', 'node_modules'])

/** Resolve the absolute DSH home: explicit flag, `$DSH_HOME`, then `~/.dsh`. */
export function resolveDshHome(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const fromEnv = env[DSH_HOME_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/** Validate a profile name against the host's own rule; throws {@link UsageError}. */
export function assertValidProfileName(name: string): void {
  if (FORBIDDEN_PROFILE_NAMES.has(name)) {
    throw new UsageError(`invalid profile name ${JSON.stringify(name)}`)
  }
  if (/[/\\]/.test(name)) {
    throw new UsageError(
      `invalid profile name ${JSON.stringify(name)}: must not contain a path separator`,
    )
  }
  if (name.includes('\0')) {
    throw new UsageError('invalid profile name: must not contain NUL')
  }
}

/** Absolute directory of one profile under a home. */
export function profileDir(home: string, name: string): string {
  assertValidProfileName(name)
  return join(home, 'profiles', name)
}

/** Absolute world-line store root under a DSH home. */
export function worldLineDir(home: string): string {
  return join(home, 'world-line')
}

/** Per-profile exclusive lock file (`world-line/locks/<profile>.lock`). */
export function profileLockPath(home: string, name: string): string {
  assertValidProfileName(name)
  return join(worldLineDir(home), 'locks', `${name}.lock`)
}

/** `world-line/state.json`. */
export function statePath(home: string): string {
  return join(worldLineDir(home), 'state.json')
}

/** `world-line/vault`. */
export function vaultDir(home: string): string {
  return join(worldLineDir(home), 'vault')
}

/** `world-line/vault/objects` (content-addressed object store). */
export function objectsDir(home: string): string {
  return join(vaultDir(home), 'objects')
}

/** One content object's path by its sha256. */
export function objectPath(home: string, sha256: string): string {
  return join(objectsDir(home), sha256)
}

/** `world-line/vault/snapshots`. */
export function snapshotsDir(home: string): string {
  return join(vaultDir(home), 'snapshots')
}

/** One snapshot manifest's path by snapshot id. */
export function snapshotManifestPath(home: string, id: string): string {
  return join(snapshotsDir(home), `${id}.json`)
}

/** `world-line/labs` (Phase 2+). */
export function labsDir(home: string): string {
  return join(worldLineDir(home), 'labs')
}

/** `world-line/reports` (Phase 4+). */
export function reportsDir(home: string): string {
  return join(worldLineDir(home), 'reports')
}

/** `world-line/vault/secrets` (encrypted bundles, Phase 4). */
export function secretsDir(home: string): string {
  return join(vaultDir(home), 'secrets')
}

/** `world-line/vault/secrets/<snapshot-id>.bin`. */
export function secretBundlePath(home: string, snapshotId: string): string {
  return join(secretsDir(home), `${snapshotId}.bin`)
}

/** `world-line/reports/<report-id>.json`. */
export function reportPath(home: string, reportId: string): string {
  return join(reportsDir(home), `${reportId}.json`)
}

/** Normalise a user-supplied relative path against the invocation cwd. */
export function absoluteFrom(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}
