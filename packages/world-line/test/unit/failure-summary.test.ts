import { describe, expect, test } from '@rstest/core'
import { failureSummary } from '../../src/client/failure-summary.js'
import type { ProbeResult } from '../../src/domain/probe.js'

describe('actionable failure summary', () => {
  test('deduplicates refused connections without suggesting authentication', () => {
    const probe = { detail: '1 client error(s): net::ERR_CONNECTION_REFUSED' } as ProbeResult
    const r = failureSummary([probe, probe, probe])
    expect(r.details).toHaveLength(1)
    expect(r.login).toBe(false)
    expect(r.title).toContain('连接被拒绝')
  })
  test('only highlights login with authentication evidence', () => {
    expect(failureSummary([{ detail: '等待登录超时' } as ProbeResult]).login).toBe(true)
  })
  test('keeps unknown failures inconclusive', () => {
    expect(failureSummary([{ detail: 'unknown error' } as ProbeResult]).title).toBe(
      '实验未达到安全合入条件',
    )
  })
})

test('does not infer package identity from a port or a package name', () => {
  const result = failureSummary(
    [{ detail: 'ERR_CONNECTION_REFUSED http://127.0.0.1:45731/state' } as ProbeResult],
    '',
    '@seaveyon/dsh-pet',
  )
  expect(JSON.stringify(result)).not.toContain('宠物')
})
