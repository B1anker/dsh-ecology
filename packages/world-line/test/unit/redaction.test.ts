/**
 * Redaction rules (invariant 6): secret shapes in free text, structured
 * trees, and detection feeds.
 */

import { describe, expect, test } from '@rstest/core'

import {
  detectSecretShapes,
  redactText,
  redactTree,
  redactValue,
} from '../../src/domain/redaction.js'

describe('redactText', () => {
  test('masks prefixed tokens', () => {
    const out = redactText('token ghp_1234567890abcdefghij and sk-abcdefghijklmnop remain masked')
    expect(out).not.toContain('ghp_1234567890')
    expect(out).not.toContain('sk-abcdefghijklmnop')
    expect(out).toContain('<redacted>')
  })

  test('masks URL credentials and keeps the user', () => {
    const out = redactText('fetch https://user:supersecret@registry.example.com/pkg')
    expect(out).toContain('https://user:<redacted>@registry.example.com/pkg')
    expect(out).not.toContain('supersecret')
  })

  test('masks bearer headers', () => {
    const out = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  test('masks sensitive key=value and key: value pairs', () => {
    const out = redactText('apiKey=sk-1234567890 next password: hunter2 done token abc')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('sk-1234567890')
    expect(out).toContain('apiKey=<redacted>')
  })

  test('keeps hashes, ids, and prose intact', () => {
    const sha = 'a'.repeat(64)
    const out = redactText(`receipt ${sha} for snapshot snap-20260904T051203Z-1a2b3c4d`)
    expect(out).toContain(sha)
    expect(out).toContain('snap-20260904T051203Z-1a2b3c4d')
  })

  test('leaves numbers and booleans readable under sensitive keys', () => {
    const out = redactText('secureCookie false, retries: 3, timeout 5000ms')
    expect(out).toContain('secureCookie false')
    expect(out).toContain('retries: 3')
    expect(out).toContain('timeout 5000ms')
  })
})

describe('redactTree / redactValue', () => {
  test('masks values under sensitive keys, keeps structure', () => {
    const tree = {
      title: 'dsh web',
      secureCookie: false,
      githubEnabled: true,
      clientSecret: 'secret-value-123',
      nested: { apiKey: 'sk-abc', hosts: ['a', 'b'] },
    }
    const out = redactTree(tree) as Record<string, unknown>
    expect(out.title).toBe('dsh web')
    expect(out.secureCookie).toBe(false)
    expect(out.clientSecret).toBe('<redacted>')
    expect((out.nested as Record<string, unknown>).apiKey).toBe('<redacted>')
    expect(out.nested).not.toContain('sk-abc')
  })

  test('redactValue masks only sensitive keys and embedded shapes', () => {
    expect(redactValue('apiKey', 'sk-1234567890')).toBe('<redacted>')
    expect(redactValue('name', 'sk-1234567890')).toBe('<redacted>')
    expect(redactValue('enabled', true)).toBe(true)
    expect(redactValue('title', 'hello')).toBe('hello')
  })
})

describe('detectSecretShapes', () => {
  test('finds token and assignment shapes', () => {
    const kinds = detectSecretShapes('apiKey: sk-1234567890\nurl: https://u:p@h/x')
    expect(kinds.length).toBeGreaterThanOrEqual(2)
    expect(kinds.join(' ')).toContain('prefixed-token')
  })

  test('clean text yields no kinds', () => {
    expect(detectSecretShapes('- id: dsh-web-login\n  config:\n    enabled: true\n')).toEqual([])
  })

  test('hashes and integrity strings are not secrets', () => {
    expect(
      detectSecretShapes(`integrity: sha512-${'a'.repeat(40)}\nsha256: ${'b'.repeat(64)}`),
    ).toEqual([])
  })
})
