/**
 * Locate and interrogate the real `dsh` binary without hardcoding paths.
 *
 * The binary comes from `$PATH` (like every other invocation of `dsh`), the
 * version from `dsh --version`. Nothing here knows where DSH is installed or
 * which port/token a running instance uses.
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

import type { DshVersion } from './types.js'

/** A resolvable `dsh` binary. */
export interface ResolvedBinary {
  /** Absolute path of the executable. */
  path: string
}

const CANDIDATE_NAMES = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']

/** Walk `$PATH` and return the first executable `dsh`, or null. */
export function findDshBinary(env: NodeJS.ProcessEnv): ResolvedBinary | null {
  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return { path: candidate }
      } catch {
        // Not executable here; keep walking.
      }
    }
  }
  return null
}

/** Parse the first semver-looking token out of `dsh --version` output. */
export function parseDshVersion(output: string): DshVersion | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(output)
  if (match === null) return null
  return {
    raw: match[0],
    core: {
      major: Number.parseInt(match[1] ?? '0', 10),
      minor: Number.parseInt(match[2] ?? '0', 10),
      patch: Number.parseInt(match[3] ?? '0', 10),
    },
    prerelease: match[4] ?? null,
  }
}

/** Run `dsh --version` once; never throws — failures become a verdict input. */
export function readDshVersion(binary: ResolvedBinary): DshVersion | null {
  const result = spawnSync(binary.path, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) return null
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return parseDshVersion(text.split(/\r?\n/, 1)[0] ?? text)
}
