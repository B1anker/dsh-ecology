import { describe, expect, test } from '@rstest/core'
import { mergeWorldResponse } from '../../src/client/world-data.js'

describe('canvas response consistency', () => {
  const base = {
    revision: 'r1',
    lines: [
      { id: 'a', state: 'running' },
      { id: 'b', state: 'running' },
    ],
    events: [{ id: 'e' }],
  }
  test('stop deltas retain other worlds and history without mutating baseline', () => {
    const next = mergeWorldResponse(
      base,
      {
        revision: 'r2',
        delta: {
          lines: { remove: [], upsert: [{ id: 'a', state: 'stopped' }] },
          events: { remove: [], upsert: [] },
        },
      },
      'r1',
    )
    expect(next.lines).toEqual([
      { id: 'a', state: 'stopped' },
      { id: 'b', state: 'running' },
    ])
    expect(next.events).toEqual(base.events)
    expect(base.lines[0]!.state).toBe('running')
  })
  test('rejects stale deltas instead of applying them to a newer baseline', () => {
    expect(() => mergeWorldResponse(base, { revision: 'r3', delta: {} }, 'r0')).toThrow(
      '版本已变化',
    )
  })
  test('rejects incomplete responses and keeps baseline intact', () => {
    expect(() => mergeWorldResponse(base, { error: 'offline' })).toThrow('已保留画布')
    expect(base.lines).toHaveLength(2)
  })
  test('unchanged response preserves lines and events', () => {
    const next = mergeWorldResponse(base, { unchanged: true, revision: 'r1', now: 'today' }, 'r1')
    expect(next.lines).toBe(base.lines)
    expect(next.events).toBe(base.events)
  })
})
