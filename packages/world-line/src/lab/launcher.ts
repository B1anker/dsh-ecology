/**
 * The Phase 2 host launcher: start a real `dsh --profile <name> --port 0
 * --no-open` against a lab DSH home, treat the first `dsh web: http://…`
 * stdout line as the host-ready signal (the web app prints it only after the
 * loader settled and webServer/connection exist — exercised against DSH
 * 0.1.2-rc.1, see docs/phase2-design.md), and tear the whole process group
 * down on stop/timeout so no dsh or plugin child outlives a lab run.
 *
 * The ready URL carries a per-boot random `?token=…` — it is held in memory
 * only and must never be written into manifests, reports, or logs verbatim.
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'

import { killTree } from './runner.js'

/** Matches the one readiness line of a successful web boot. */
export const WEB_READY_LINE_RE = /^dsh web: (http:\/\/\S+)/

/** Parse a readiness line; null when it is not one. */
export function parseReadyLine(line: string): { url: string; port: number } | null {
  const match = WEB_READY_LINE_RE.exec(line.trim())
  if (match === null || match[1] === undefined) return null
  const url = match[1]
  let port: number
  try {
    port = Number(new URL(url).port)
  } catch {
    return null
  }
  if (!Number.isInteger(port) || port <= 0) return null
  return { url, port }
}

/** A booted dsh web process owned by this launcher. */
export interface RunningDsh {
  readonly pid: number
  /** Authenticated loopback URL incl. the per-boot token; memory only. */
  readonly url: string
  readonly port: number
  /** Stop the process group; returns the collected transcript. */
  stop(): Promise<{
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
  }>
}

export type LaunchFailureKind = 'spawn-error' | 'exited' | 'timeout'

export interface LaunchResult {
  kind: 'ready' | LaunchFailureKind
  /** Set on ready. */
  handle?: RunningDsh
  /** Human detail (redact before persisting anywhere). */
  detail: string
}

export interface LaunchOptions {
  dshBinary: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Milliseconds to wait for the ready line before failing as timeout. */
  readyTimeoutMs?: number
  /** Grace after the ready line before resolving, so HTTP accepts. */
  settleGraceMs?: number
  /**
   * Keep the booted dsh running after this process returns (rescue): unref
   * the child and its stdio so the CLI can exit while dsh serves on.
   */
  keepAlive?: boolean
}

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_SETTLE_GRACE_MS = 250
const STOP_GRACE_MS = 3_000

/** Launch and wait for the ready line; resolves on ready or a failure kind. */
export function launchDsh(options: LaunchOptions): Promise<LaunchResult> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS

  return new Promise<LaunchResult>((resolve) => {
    const child: ChildProcess = spawn(options.dshBinary, [...options.args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let ready: { url: string; port: number } | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let settle: ReturnType<typeof setTimeout> | null = null

    const finish = (result: LaunchResult): void => {
      if (settled) return
      settled = true
      if (deadline !== null) clearTimeout(deadline)
      if (settle !== null) clearTimeout(settle)
      resolve(result)
    }
    const succeed = (): void => {
      if (ready === null) return
      if (options.keepAlive === true) {
        // Node's Stream typings omit unref; it exists on pipe handles.
        const unrefStream = (stream: unknown): void => {
          ;(stream as { unref?: () => void } | undefined)?.unref?.()
        }
        unrefStream(child.stdout)
        unrefStream(child.stderr)
        child.unref?.()
      }
      finish({
        kind: 'ready',
        detail: `dsh web ready on 127.0.0.1:${ready.port}`,
        handle: {
          pid: child.pid ?? 0,
          url: ready.url,
          port: ready.port,
          stop: () =>
            stopGroup(
              child,
              () => stdout,
              () => stderr,
            ),
        },
      })
    }
    const fail = (kind: LaunchFailureKind, detail: string): void => {
      if (settled) return
      finish({ kind, detail })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (ready !== null) return
      for (const line of stdout.split('\n')) {
        const parsed = parseReadyLine(line)
        if (parsed !== null) {
          ready = parsed
          // Cancel the timeout; let the server accept connections first.
          if (deadline !== null) clearTimeout(deadline)
          settle = setTimeout(succeed, settleGraceMs)
          return
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail('spawn-error', error.code ?? error.message)
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (ready !== null) return // died after ready: the caller owns teardown
      fail(
        'exited',
        `dsh exited before ready (code ${String(code)}${signal === null ? '' : `, signal ${signal}`}) — ${lastLines(`${stdout}\n${stderr}`, 4)}`,
      )
    })

    deadline = setTimeout(() => {
      fail(
        'timeout',
        `no ready line within ${readyTimeoutMs} ms — ${lastLines(`${stdout}\n${stderr}`, 10)}`,
      )
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), STOP_GRACE_MS).unref()
    }, readyTimeoutMs)
  })
}

/** Last non-empty lines of a transcript, joined; empty string when none. */
export function lastLines(transcript: string, count: number): string {
  const lines = transcript
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  return lines.slice(-count).join(' | ')
}

/** SIGTERM the group, escalate to SIGKILL after the grace, and wait. */
async function stopGroup(
  child: ChildProcess,
  readStdout: () => string,
  readStderr: () => string,
): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  if (child.exitCode === null && child.signalCode === null) {
    killTree(child, 'SIGTERM')
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    const grace = setTimeout(() => {
      killTree(child, 'SIGKILL')
    }, STOP_GRACE_MS)
    child.once('close', (code: number | null) => {
      clearTimeout(grace)
      resolve(code)
    })
  })
  return { exitCode, signal: child.signalCode, stdout: readStdout(), stderr: readStderr() }
}
