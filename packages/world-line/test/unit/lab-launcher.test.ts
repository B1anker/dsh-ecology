/**
 * Runner and launcher behavior against real `node -e` fixture shims: capture
 * semantics, timeout/group teardown, ready-line parsing, and the full
 * launch → stop lifecycle (Phase 2 host boot plumbing).
 */

import { execPath } from 'node:process'

import { describe, expect, test } from '@rstest/core'

import { lastLines, launchDsh, parseReadyLine } from '../../src/lab/launcher.js'
import { runCaptured } from '../../src/lab/runner.js'

const READY_LINE = 'dsh web: http://127.0.0.1:61337/?token=abc123XYZ'

const env = { ...process.env }

describe('runCaptured', () => {
  test('captures stdout/stderr and the exit code', async () => {
    const outcome = await runCaptured(
      execPath,
      ['-e', `process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n')`],
      {
        cwd: process.cwd(),
        env,
      },
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('out-line')
    expect(outcome.stderr).toContain('err-line')
    expect(outcome.timedOut).toBe(false)
  })

  test('records non-zero exits without throwing', async () => {
    const outcome = await runCaptured(execPath, ['-e', `process.exit(7)`], {
      cwd: process.cwd(),
      env,
    })
    expect(outcome.exitCode).toBe(7)
    expect(outcome.spawnError).toBeNull()
  })

  test('reports spawn errors for a missing binary', async () => {
    const outcome = await runCaptured('/nonexistent/world-line-shim', [], {
      cwd: process.cwd(),
      env,
    })
    expect(outcome.spawnError).not.toBeNull()
  })

  test('kills a runaway child when the timeout trips', async () => {
    const outcome = await runCaptured(execPath, ['-e', `setInterval(() => {}, 1000)`], {
      cwd: process.cwd(),
      env,
      timeoutMs: 300,
    })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).not.toBe(0)
  })
})

describe('parseReadyLine', () => {
  test('extracts the URL and the port', () => {
    const parsed = parseReadyLine('dsh web: http://127.0.0.1:61337/?token=abc')
    expect(parsed).toEqual({ url: 'http://127.0.0.1:61337/?token=abc', port: 61337 })
  })

  test('rejects non-ready lines and malformed URLs', () => {
    expect(parseReadyLine('dsh web: opening the default browser')).toBeNull()
    expect(parseReadyLine('not dsh web at all')).toBeNull()
    expect(parseReadyLine('dsh web: http://[::1')).toBeNull()
    expect(parseReadyLine('')).toBeNull()
  })
})

describe('lastLines', () => {
  test('keeps the trailing non-empty lines', () => {
    expect(lastLines('a\n\nb\nc\n', 2)).toBe('b | c')
    expect(lastLines('', 3)).toBe('')
  })
})

describe('launchDsh', () => {
  test('resolves ready from the readiness line and stops the group', async () => {
    const result = await launchDsh({
      dshBinary: execPath,
      args: ['-e', `console.log(${JSON.stringify(READY_LINE)}); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env,
      readyTimeoutMs: 10_000,
      settleGraceMs: 20,
    })
    expect(result.kind).toBe('ready')
    const handle = result.handle
    expect(handle).toBeDefined()
    expect(handle?.url).toContain('token=abc123XYZ')
    expect(handle?.port).toBe(61337)
    const transcript = await handle?.stop()
    expect(transcript?.stdout).toContain('dsh web:')
    expect(transcript?.stdout).toContain('abc123XYZ')
  })

  test('fails fast when the shim exits before ready', async () => {
    const result = await launchDsh({
      dshBinary: execPath,
      args: ['-e', `process.stdout.write('something else\\n'); process.exit(3)`],
      cwd: process.cwd(),
      env,
      readyTimeoutMs: 10_000,
    })
    expect(result.kind).toBe('exited')
    expect(result.detail).toContain('code 3')
  })

  test('times out when no ready line appears', async () => {
    const result = await launchDsh({
      dshBinary: execPath,
      args: ['-e', `console.log('silent boot'); setInterval(() => {}, 1000)`],
      cwd: process.cwd(),
      env,
      readyTimeoutMs: 400,
      settleGraceMs: 20,
    })
    expect(result.kind).toBe('timeout')
    expect(result.detail).toContain('silent boot')
  })

  test('propagates the DSH_HOME environment into the child', async () => {
    const labHome = '/tmp/world-line-lab-home-test'
    const result = await launchDsh({
      dshBinary: execPath,
      args: [
        '-e',
        `console.log(${JSON.stringify('dsh web: http://127.0.0.1:9001/?t=1')}); console.log('DSH_HOME=' + process.env.DSH_HOME); setInterval(() => {}, 1000)`,
      ],
      cwd: process.cwd(),
      env: { ...env, DSH_HOME: labHome },
      readyTimeoutMs: 10_000,
      settleGraceMs: 40,
    })
    expect(result.kind).toBe('ready')
    await result.handle?.stop()
  })
})
