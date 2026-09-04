import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import { createSecurityAudit } from '../../src/audit.js'

test('security audit appends private structured events without credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-login-audit-'))
  const path = join(dir, 'audit.jsonl')
  try {
    const audit = createSecurityAudit(path, () => new Date('2026-09-05T00:00:00.000Z'))
    audit.record('login_succeeded', { client: '127.0.0.1/32', provider: 'password' })
    const body = readFileSync(path, 'utf8')
    expect(JSON.parse(body)).toEqual({
      timestamp: '2026-09-05T00:00:00.000Z',
      event: 'login_succeeded',
      client: '127.0.0.1/32',
      provider: 'password',
    })
    expect(statSync(path).mode & 0o077).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('security audit keeps one bounded rotated file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-login-audit-'))
  const path = join(dir, 'audit.jsonl')
  try {
    const audit = createSecurityAudit(
      path,
      () => new Date('2026-09-05T00:00:00.000Z'),
      undefined,
      1,
    )
    audit.record('login_failed', { client: '127.0.0.1/32' })
    audit.record('logout', { client: '127.0.0.1/32' })

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(JSON.parse(readFileSync(`${path}.1`, 'utf8')).event).toBe('login_failed')
    expect(JSON.parse(readFileSync(path, 'utf8')).event).toBe('logout')
    expect(statSync(`${path}.1`).mode & 0o077).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('security audit reports write errors without breaking the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-login-audit-'))
  const path = join(dir, 'audit.jsonl')
  const errors: unknown[] = []
  try {
    const audit = createSecurityAudit(path, undefined, (error) => errors.push(error))
    mkdirSync(path)

    expect(() => audit.record('login_failed')).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('not a regular file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
