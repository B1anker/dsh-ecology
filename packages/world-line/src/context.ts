/**
 * The environment one command runs in. `run()`-level functions receive this
 * instead of touching process directly so tests can drive the full CLI
 * surface in-process with injected cwd/env/clock.
 */

/** The resolved invocation context handed to every command. */
export interface CliContext {
  /** Set by the authenticated same-origin management route only; never deserialized. */
  authenticatedWebAction?: boolean
  /** Process cwd (path specs resolve against this). */
  cwd: string
  /** Selected home's .env merged with the inherited process environment. */
  env: NodeJS.ProcessEnv
  /** Separate environment for experimental child processes; official operations use env. */
  experimentEnv?: NodeJS.ProcessEnv
  /** Omit the official .env from experiment runtime inheritance (shell variables remain). */
  noInheritEnv?: boolean
  /** Absolute DSH home (explicit flag > $DSH_HOME > ~/.dsh). */
  home: string
  /** The profile the invocation names. */
  profileName: string
  /** Whether the caller asked for JSON envelopes. */
  json: boolean
  /** Whether stale writer locks may be broken (explicit user confirmation). */
  breakStaleLock: boolean
  /** Injectable clock. */
  now(): Date
}

import { arch, platform, release } from 'node:os'

/** Node/OS facts recorded into manifests and doctor output. */
export function runtimeEnvironment(): { nodeVersion: string; os: string; arch: string } {
  return { nodeVersion: process.version, os: `${platform()} ${release()}`, arch: arch() }
}
