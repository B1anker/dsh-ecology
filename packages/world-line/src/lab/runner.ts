/**
 * One captured run of a real child executable (dsh, pnpm-through-dsh, or any
 * fixture shim): async spawn with stdout/stderr capture, a hard timeout, and
 * process-group teardown so pnpm/dsh descendants cannot outlive the run.
 *
 * Spawns detached (own process group) so teardown can signal the whole tree;
 * on POSIX the negative pid signals the group, on Windows the process pid is
 * signalled (the same fallback dsh itself uses for its own children).
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'

/** The outcome of one captured run. */
export interface RunOutcome {
  /** Exit code, or null when the process was killed by a signal. */
  exitCode: number | null
  /** Signal name when the process died from one. */
  signal: string | null
  /** Whether the hard timeout tripped (run was group-killed). */
  timedOut: boolean
  /** Set when the process could not be spawned at all (ENOENT etc.). */
  spawnError: string | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Hard cap; a tripped timeout group-kills the child. Default 120s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const TERM_GRACE_MS = 2_000

/** Kill a detached child and its process group. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to the single-process kill below (e.g. ESRCH).
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already gone.
  }
}

/** Run a command capturing stdout/stderr; never throws for child failures. */
export async function runCaptured(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

  const outcome: RunOutcome = {
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdout: '',
    stderr: '',
  }

  return await new Promise<RunOutcome>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      outcome.stdout = Buffer.concat(stdout).toString('utf8')
      outcome.stderr = Buffer.concat(stderr).toString('utf8')
      resolve(outcome)
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      outcome.spawnError = error.code ?? error.message
      if (error.code === 'ENOENT') outcome.exitCode = null
      finish()
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      outcome.exitCode = code
      outcome.signal = signal
      finish()
    })

    timer = setTimeout(() => {
      outcome.timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), TERM_GRACE_MS).unref()
    }, timeoutMs)
  })
}
