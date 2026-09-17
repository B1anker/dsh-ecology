/**
 * Lab host gate (WORLD-LINE-SPEC invariant 7, Phase 2): every lab operation
 * is version-sensitive, so it requires a `dsh` binary whose exact version was
 * exercised against the adapter (fail closed — read-only doctor/snapshot stay
 * available, labs refuse to guess). Plugin management additionally forwards to
 * real pnpm, so install-plan operations require pnpm on PATH with a clear
 * message when it is missing.
 */

import { accessSync, constants } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import type { ResolvedBinary } from '../host-adapters/detect.js'
import { findDshBinary, readDshVersion } from '../host-adapters/detect.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import type { DshVersion } from '../host-adapters/types.js'
import type { LabAction } from './manifest.js'

/** A host the lab machinery is allowed to drive. */
export interface KnownHost {
  binary: ResolvedBinary
  version: DshVersion
  adapterId: string
  /** Exact version string, e.g. `0.1.2-rc.1`. */
  raw: string
}

/** Whether one plan needs pnpm (dependency mutations do; config-apply does not). */
export function planNeedsPnpm(action: LabAction): boolean {
  return action === 'add' || action === 'update' || action === 'remove'
}

/**
 * Resolve and verify the host; throws UsageError (exit 2) fail-closed when the
 * binary is missing, its version is unparseable, or the version is not part of
 * the adapter's exercised evidence set.
 */
export function requireKnownHost(ctx: CliContext): KnownHost {
  const binary = findDshBinary(ctx.env)
  if (binary === null) {
    throw new UsageError(
      'lab operations need dsh on PATH — no executable found; doctor/snapshot stay available',
    )
  }
  const version = readDshVersion(binary)
  const verdict = adapterDsh01x.verdict(version, version === null)
  if (!verdict.known || version === null) {
    throw new UsageError(`refusing lab work (fail closed): ${verdict.reason}`)
  }
  const raw = `${version.core.major}.${version.core.minor}.${version.core.patch}${
    version.prerelease === null ? '' : `-${version.prerelease}`
  }`
  return { binary, version, adapterId: adapterDsh01x.id, raw }
}

/**
 * Every path a pnpm executable could sit at, in PATH order: each directory
 * joined with the platform's executable names. PATH is split on the
 * platform's list separator — `;` on Windows, where a `:` split would cut
 * every `C:\…` entry in two and report pnpm missing — the same way
 * {@link findDshBinary} walks it. Pure, so the Windows shape is testable on
 * any host.
 */
export function pnpmCandidates(pathValue: string, platform: NodeJS.Platform): string[] {
  const names = platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']
  const pathApi = platform === 'win32' ? win32 : posix
  return pathValue
    .split(pathApi.delimiter)
    .filter((dir) => dir !== '')
    .flatMap((dir) => names.map((name) => pathApi.join(dir, name)))
}

/**
 * Locate pnpm on PATH; throws UsageError with guidance when absent.
 * `platform` selects the PATH dialect (see {@link pnpmCandidates}).
 */
export function requirePnpm(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { path: string } {
  for (const candidate of pnpmCandidates(env.PATH ?? '', platform)) {
    try {
      accessSync(candidate, constants.X_OK)
      return { path: candidate }
    } catch {
      // Keep walking.
    }
  }
  throw new UsageError(
    'installing or removing plugins forwards to pnpm (dsh plugin is a pnpm forwarder) — ' +
      'no pnpm executable found on PATH; config-apply and compose/boot checks do not need pnpm',
  )
}
