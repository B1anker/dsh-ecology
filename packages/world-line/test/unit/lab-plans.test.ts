/**
 * Candidate-spec parsing and plan building (WORLD-LINE-SPEC §3/§6).
 * Local candidates keep absolute paths; registry specs carry name/version;
 * a bare `@scope/name` is a valid registry name (used by lab remove).
 */

import { describe, expect, test } from '@rstest/core'

import { UsageError } from '../../src/domain/errors.js'
import { buildPlan, parseCandidateSpec, stepNeedsPnpm } from '../../src/lab/plans.js'

describe('parseCandidateSpec', () => {
  test('bare package names and versions', () => {
    expect(parseCandidateSpec('dsh-base')).toEqual({ name: 'dsh-base' })
    expect(parseCandidateSpec('dsh-base@^1.2.0')).toEqual({
      name: 'dsh-base',
      version: '^1.2.0',
    })
  })

  test('scoped names with and without versions', () => {
    expect(parseCandidateSpec('@deepseek-ai/dsh-web-app')).toEqual({
      name: '@deepseek-ai/dsh-web-app',
    })
    expect(parseCandidateSpec('@deepseek-ai/dsh-web-app@1.0.0')).toEqual({
      name: '@deepseek-ai/dsh-web-app',
      version: '1.0.0',
    })
  })

  test('file: and link: resolve to absolute local paths', () => {
    const parsed = parseCandidateSpec('file:./plugins/x', '/work/profile')
    expect(parsed.localPath).toBe('/work/profile/plugins/x')
    expect(parsed.name).toBe('x')
    expect(parseCandidateSpec('link:/tmp/p', '/work').localPath).toBe('/tmp/p')
  })

  test('bare relative paths are rejected with guidance', () => {
    expect(() => parseCandidateSpec('./plugins/x', '/work')).toThrowError(UsageError)
    expect(() => parseCandidateSpec('./plugins/x', '/work')).toThrowError(/file: or link:/)
  })
})

describe('buildPlan verb mapping', () => {
  test('add local candidate keeps an offline file: spec and redacts paths', () => {
    const spec = parseCandidateSpec('file:/tmp/plug', '/work')
    const steps = buildPlan({ action: 'add', spec })
    expect(steps[0]?.action).toBe('add')
    expect(steps[0]?.spec).toBe('file:/tmp/plug')
    expect(steps[0]?.detail).toBe('local candidate (offline)')
  })

  test('add registry candidate carries name@version', () => {
    const spec = parseCandidateSpec('x@2.0.0', '/work')
    const steps = buildPlan({ action: 'add', spec })
    expect(steps[0]?.spec).toBe('x@2.0.0')
    expect(steps[0]?.id).toBe('x')
  })

  test('remove rejects versions and paths', () => {
    expect(stepNeedsPnpm('remove')).toBe(true)
    expect(() =>
      buildPlan({ action: 'remove', spec: { name: 'x', version: '1.0.0' } }),
    ).toThrowError(UsageError)
    expect(() =>
      buildPlan({ action: 'remove', spec: { name: 'x', localPath: '/p' } }),
    ).toThrowError(UsageError)
  })

  test('config-apply plans point at the materialized overlay', () => {
    const steps = buildPlan({ action: 'config-apply', overlayPath: '/lab/config-apply.yml' })
    expect(steps[0]?.action).toBe('config-apply')
    expect(steps[0]?.overlayPath).toBe('/lab/config-apply.yml')
    expect(steps[0]?.id).toBeUndefined()
  })
})
