import { describe, expect, test } from '@rstest/core'
import { mergeWorldResponse } from '../../src/client/world-data.js'

describe('canvas response consistency', () => {
  const base = {
    revision: 'r1',
    lines: [
      { id: 'a', state: 'running' },
      { id: 'b', state: 'running' },
    ],
    events: [{ id: 'e', at: '2026-09-08T08:15:33.801Z' }],
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

test('unfinished verification timestamps cannot poison full or delta canvas responses', () => {
  const created = { id: 'created', at: '2026-09-08T08:15:33.801Z' }
  const unfinished = { id: 'verification', at: '' }
  const full = mergeWorldResponse(null, {
    revision: 'r1',
    lines: [],
    events: [created, unfinished],
  })
  expect(full.events).toEqual([created])
  const next = mergeWorldResponse(
    full,
    {
      revision: 'r2',
      delta: {
        lines: { remove: [], upsert: [] },
        events: { remove: [], upsert: [unfinished, { id: 'bad', at: 'invalid' }] },
      },
    },
    'r1',
  )
  expect(next.events).toEqual([created])
  expect(
    new Date(
      Math.min(...next.events.map((event: { at: string }) => Date.parse(event.at))),
    ).toISOString(),
  ).toBe(created.at)
})
