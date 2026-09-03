/**
 * Best-effort restart of a running DSH Web process.
 *
 * After the password verifier changes, an already-running gate keeps the old
 * hash in memory. The hash CLI therefore looks for a live `dsh web` (or
 * `--profile web`) process, reuses its argv, and relaunches it in a fully
 * detached session so the CLI (and `dsh plugin exec`) can exit immediately.
 *
 * @module @seaveyon/dsh-web-login/restart-dsh
 */

import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A discovered DSH Web process. */
export interface DshWebProcess {
  pid: number
  argv: string[]
}

/**
 * Whether a process command line is a DSH Web boot (not plugin/hash helpers).
 * @param command - full command line from `ps`.
 * @returns true when this looks like a web profile boot.
 */
export function isDshWebCommand(command: string): boolean {
  if (!/\bdsh\b/.test(command)) return false
  if (/\bdsh-web-login-hash\b/.test(command)) return false
  if (/\bplugin\b/.test(command)) return false
  // `dsh web …` or `dsh --profile web …` (flags may appear before the profile).
  if (/(?:^|\s)web(?:\s|$)/.test(command) && !/--profile\s+\S+/.test(command)) return true
  if (/--profile(?:\s+|=)web(?:\s|$)/.test(command)) return true
  return false
}

/**
 * Split a `ps` command line into argv tokens.
 *
 * Adequate for the argv shapes `dsh` itself prints (`dsh web --host …`); it is
 * not a full shell parser and must not be fed untrusted input.
 *
 * @param command - raw command line.
 * @returns argv tokens.
 */
export function splitCommandLine(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/**
 * List running DSH Web processes on this machine.
 * @returns zero or more process descriptors.
 */
export async function listDshWebProcesses(): Promise<DshWebProcess[]> {
  // `ps` is portable enough for macOS and Linux, which is where this CLI runs.
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], {
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  })
  const out: DshWebProcess[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = trimmed.match(/^(\d+)\s+(.*)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (pid === process.pid || pid === process.ppid) continue
    if (!isDshWebCommand(command)) continue
    const argv = splitCommandLine(command)
    if (argv.length === 0) continue
    out.push({ pid, argv })
  }
  return out
}

/**
 * Wait until a pid is gone, or the timeout elapses.
 * @param pid - process to wait for.
 * @param timeoutMs - maximum wait.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Launch argv in a new session that cannot keep this CLI's event loop open.
 *
 * Opening `/dev/null` ourselves and calling `unref()` is required: with only
 * `stdio: 'ignore'`, some hosts still keep a handle that prevents
 * `dsh plugin exec` from returning after the hash CLI finishes.
 *
 * @param argv - command and arguments to launch.
 * @returns the new process id when known.
 */
export function spawnDetached(argv: readonly string[]): number | undefined {
  if (argv.length === 0) return undefined
  const devNull = openSync('/dev/null', 'w')
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: ['ignore', devNull, devNull],
      env: process.env,
    })
    child.unref()
    return child.pid
  } finally {
    closeSync(devNull)
  }
}

/**
 * Restart every discovered DSH Web process with its original argv.
 *
 * @returns a short human-readable summary for the CLI to print.
 */
export async function restartDshWebProcesses(): Promise<string> {
  let processes: DshWebProcess[]
  try {
    processes = await listDshWebProcesses()
  } catch (error) {
    return `Could not look for a running dsh web process (${
      error instanceof Error ? error.message : 'unknown error'
    }); start dsh yourself.`
  }

  if (processes.length === 0) {
    return 'No running dsh web process found; start dsh yourself to use the new password.'
  }

  const lines: string[] = []
  for (const proc of processes) {
    try {
      process.kill(proc.pid, 'SIGTERM')
    } catch (error) {
      lines.push(
        `Could not stop pid ${proc.pid}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      )
      continue
    }

    await waitForExit(proc.pid, 3000)
    try {
      // Force if it ignored SIGTERM — better a hard stop than a stuck port.
      process.kill(proc.pid, 'SIGKILL')
      await waitForExit(proc.pid, 1000)
    } catch {
      /* already gone */
    }

    const newPid = spawnDetached(proc.argv)
    if (newPid === undefined) {
      lines.push(`Stopped pid ${proc.pid}, but failed to relaunch dsh web.`)
      continue
    }
    lines.push(`Restarted dsh web (was pid ${proc.pid}, now pid ${newPid}).`)
  }
  return lines.join('\n')
}
