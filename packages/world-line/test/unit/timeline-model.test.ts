import { describe, expect, test } from '@rstest/core'
import {
  adjacentEvent,
  aliasValidation,
  cursorTime,
  eventMarkers,
  type Line,
  lineColor,
  pointTime,
  TRACK_END,
  TRACK_LEFT,
  timelineScale,
  timeX,
} from '../../src/client/timeline-model.js'

const line: Line = {
  id: 'new-id',
  alias: 'branch',
  createdAt: new Date(2000).toISOString(),
  kind: 'mirror',
  state: 'applying',
  verdict: null,
  isDefault: false,
}
describe('creation alias polling race', () => {
  test('a submitted alias stays neutral when its own lab appears before startup completes', () => {
    expect(aliasValidation('branch', [])).toBe('')
    expect(aliasValidation('branch', [], undefined, true)).toBe('')
    expect(aliasValidation('branch', [line], undefined, true)).toBe('')
    // Once editable again (including after a failed startup), real conflicts must surface.
    expect(aliasValidation('branch', [line])).toContain('已被使用')
  })
  test('editing a line permits its existing alias but rejects another line and reserved IDs', () => {
    expect(aliasValidation('branch', [line], line.id)).toBe('')
    expect(aliasValidation('branch', [line], 'other-id')).toContain('已被使用')
    expect(aliasValidation('lab-invalid', [])).not.toBe('')
  })
})
describe('timeline time-point coordinates', () => {
  test('flow-space coordinates preserve time across the range', () => {
    expect(timeX(1000, 1000, 5000)).toBe(TRACK_LEFT)
    expect(timeX(5000, 1000, 5000)).toBe(TRACK_END)
    for (const at of [2000, 3500, 5000])
      expect(pointTime(timeX(at, 1000, 5000), line, 1000, 5000)).toBe(at)
  })
  test('context actions cannot point before birth or after now, including label clicks', () => {
    expect(pointTime(-1000, line, 1000, 5000)).toBe(2000)
    expect(pointTime(TRACK_END + 200, line, 1000, 5000)).toBe(5000)
  })
})

describe('persistent timeline history', () => {
  const events = [
    {
      id: 's2',
      lineId: line.id,
      at: new Date(9000).toISOString(),
      kind: 'snapshot' as const,
      title: 'Later',
      detail: '',
    },
    {
      id: 'c',
      lineId: line.id,
      at: new Date(2000).toISOString(),
      kind: 'created' as const,
      title: 'Created',
      detail: '',
    },
    {
      id: 's1',
      lineId: line.id,
      at: new Date(6000).toISOString(),
      kind: 'snapshot' as const,
      title: 'First',
      detail: '',
    },
    {
      id: 'other',
      lineId: 'other',
      at: new Date(5000).toISOString(),
      kind: 'snapshot' as const,
      title: 'Other',
      detail: '',
    },
  ]
  test('polling follows now only in live mode; historical instants remain exact', () => {
    expect(cursorTime(null, 10000)).toBe(10000)
    expect(cursorTime(null, 20000)).toBe(20000)
    expect(cursorTime(6000, 10000)).toBe(6000)
    expect(cursorTime(6000, 20000)).toBe(6000)
  })
  test('all owned events survive timeline growth and clustering without mutating the source', () => {
    for (const end of [10000, 1000000]) {
      const markers = eventMarkers(events, line, 1000, end)
      expect(markers.flatMap((marker) => marker.events.map((event) => event.id))).toEqual([
        'c',
        's1',
        's2',
      ])
      expect(markers.every((marker, index) => !index || marker.x >= markers[index - 1]!.x)).toBe(
        true,
      )
    }
    expect(events[0]!.id).toBe('s2')
  })
  test('jumps use chronological instants across unordered events and stop at boundaries', () => {
    expect(adjacentEvent(events, 6000, -1)?.id).toBe('other')
    expect(adjacentEvent(events, 6000, 1)?.id).toBe('s2')
    expect(adjacentEvent(events, 9000, 1)).toBeUndefined()
    expect(adjacentEvent(events, 2000, -1)).toBeUndefined()
    expect(adjacentEvent([], 6000, 1)).toBeUndefined()
  })
  test('reference colors belong to stable IDs', () => {
    expect(lineColor(line.id)).toMatch(/^#[0-9a-f]{6}$/)
    expect(lineColor('origin')).toBe('#00dedf')
    expect(
      new Set(
        [
          'lab-20260906T065803Z-eb776f86',
          'lab-20260906T115850Z-51272a98',
          'lab-20260906T143145Z-f52a744d',
        ].map(lineColor),
      ).size,
    ).toBe(3)
  })
})

describe('long idle timeline spacing', () => {
  test('keeps a short burst readable after a year without events and maps clicks back to real time', () => {
    const minute = 60000,
      end = 365 * 86400000
    const scale = timelineScale(0, end, [minute, 2 * minute, 3 * minute])
    expect(scale.compressed).toBe(true)
    expect(scale.toX(2 * minute) - scale.toX(minute)).toBeGreaterThan(20)
    expect(scale.gaps).toHaveLength(1)
    for (const at of [0, minute, 3 * minute, end / 2, end])
      expect(Math.abs(scale.toTime(scale.toX(at)) - at)).toBeLessThan(0.01)
    expect(scale.toTime(-100)).toBe(0)
    expect(scale.toTime(2000)).toBe(end)
  })
  test('uses proportional time when there are no long idle gaps', () => {
    const scale = timelineScale(0, 3600000, [60000, NaN, 60000])
    expect(scale.compressed).toBe(false)
    expect(scale.toX(1800000)).toBeCloseTo(timeX(1800000, 0, 3600000))
    expect(scale.gaps).toEqual([])
  })
})
