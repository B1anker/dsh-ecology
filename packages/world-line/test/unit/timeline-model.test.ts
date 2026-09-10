import { describe, expect, test } from '@rstest/core'
import {
  adjacentEvent,
  aliasValidation,
  canvasConnections,
  clusterZoom,
  cursorTime,
  eventMarkers,
  type Line,
  lineColor,
  mergeConnectionPath,
  pointTime,
  restoreRelation,
  TRACK_END,
  TRACK_LEFT,
  timelineScale,
  timeX,
} from '../../src/client/timeline-model.js'

test('merge curves leave the right edge horizontally and finish with a vertical arrow', () => {
  expect(mergeConnectionPath(500, 300, 500, 102)).toBe(
    'M 514 300 L 522 300 C 538 300, 500 209, 500 130 L 500 118',
  )
  expect(mergeConnectionPath(500, 300, 560, 102)).toBe('M 514 300 L 522 300 A 38 182 0 0 0 560 118')
  expect(mergeConnectionPath(550, 300, 530, 102)).toBe(
    'M 564 300 L 572 300 C 589 300, 530 209, 530 130 L 530 118',
  )
  expect(mergeConnectionPath(100, 216, 500, 126)).toBe(
    'M 114 216 L 381.6 216 A 118.4 74 0 0 0 500 142',
  )
  expect(mergeConnectionPath(500, 102, 560, 300)).toBe('M 514 102 L 522 102 A 38 182 0 0 1 560 284')
})

const line: Line = {
  id: 'new-id',
  alias: 'branch',
  createdAt: new Date(2000).toISOString(),
  kind: 'mirror',
  state: 'applying',
  verdict: null,
  isDefault: false,
}
test('shared spacing keeps a merge after its source despite expanded restoration markers', () => {
  const source = { ...line, createdAt: new Date(0).toISOString() }
  const target = { ...source, id: 'origin' }
  const records = [
    { id: 'snapshot', at: 10000, lineId: source.id, kind: 'snapshot' },
    { id: 'restore', at: 10001, lineId: source.id, kind: 'restore' },
    { id: 'applied', at: 10002, lineId: source.id, kind: 'operation' },
    { id: 'merge', at: 10003, lineId: target.id, kind: 'merge' },
    { id: 'merge-again', at: 20000, lineId: target.id, kind: 'merge' },
  ].map((event) => ({
    ...event,
    kind: event.kind as 'snapshot' | 'restore' | 'operation' | 'merge',
    at: new Date(event.at).toISOString(),
    title: event.id,
    detail: '',
  }))
  const ids = ['snapshot', 'restore', 'merge', 'merge-again']
  const scale = timelineScale(
    0,
    86400000,
    records.map((event) => Date.parse(event.at)),
    records.filter((event) => ids.includes(event.id)).map((event) => Date.parse(event.at)),
  )
  const sourceMarkers = eventMarkers(records, source, 0, 86400000, scale.toX, ids)
  const targetMarkers = eventMarkers(records, target, 0, 86400000, scale.toX, ids)
  const applied = sourceMarkers.find((marker) =>
    marker.events.some((event) => event.id === 'applied'),
  )!
  expect(applied.x).toBeLessThan(targetMarkers[0]!.x)
  for (const marker of [...sourceMarkers, ...targetMarkers])
    expect(marker.x + scale.toX(0)).toBeCloseTo(scale.toX(Date.parse(marker.events[0]!.at)))
})
describe('canvas connections after parent removal', () => {
  const origin = { ...line, id: 'origin', kind: 'origin' }
  const parent = { ...line, id: 'old-login', parentId: 'origin' }
  const child = { ...line, id: 'new-login', parentId: parent.id }
  test('deleting the parent keeps a marked visual connection without changing the source', () => {
    expect(canvasConnections([origin, parent, child])).toEqual([
      { source: 'origin', target: parent.id, missing: false },
      { source: parent.id, target: child.id, missing: false },
    ])
    expect(canvasConnections([origin, child])).toEqual([
      { source: 'origin', target: child.id, missing: true },
    ])
    expect(child.parentId).toBe(parent.id)
    expect(canvasConnections([origin, parent, child])[1]?.missing).toBe(false)
  })
  test('keeps descendants attached and never creates edges to absent anchors or self', () => {
    const descendant = { ...line, id: 'descendant', parentId: child.id }
    expect(canvasConnections([origin, child, descendant])).toEqual([
      { source: 'origin', target: child.id, missing: true },
      { source: child.id, target: descendant.id, missing: false },
    ])
    expect(canvasConnections([child])).toEqual([])
    expect(canvasConnections([origin, { ...child, parentId: child.id }])).toEqual([
      { source: 'origin', target: child.id, missing: true },
    ])
  })
})
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
  test('restore relationships use the target snapshot on the same line and detect later changes', () => {
    const target = {
      id: 'target',
      lineId: line.id,
      at: new Date(1000).toISOString(),
      kind: 'snapshot' as const,
      snapshotId: 'snap-target',
      title: 'Before',
      detail: '',
    }
    const restore = {
      ...target,
      id: 'restore',
      kind: 'restore' as const,
      at: new Date(3000).toISOString(),
      unchanged: true,
    }
    expect(restoreRelation([restore, target], line.id)).toEqual({ restore, target, later: false })
    const later = {
      ...target,
      id: 'later',
      snapshotId: 'snap-new',
      at: new Date(4000).toISOString(),
    }
    expect(restoreRelation([later, target, restore], line.id)?.later).toBe(true)
    expect(restoreRelation([restore, { ...target, lineId: 'other' }], line.id)).toBeNull()
  })
  test('identical timestamps stay grouped without shifting later events', () => {
    const records = [10000, 10000, 10001, 10002].map((at, index) => ({
      id: String(index),
      lineId: line.id,
      at: new Date(at).toISOString(),
      kind: 'snapshot' as const,
      title: 'Snapshot',
      detail: '',
    }))
    const scale = timelineScale(
      0,
      3600000,
      records.map((event) => Date.parse(event.at)),
      [10000, 10000],
    )
    const markers = eventMarkers(records, line, 0, 3600000, scale.toX, ['0', '1'])
    expect(markers[0]!.events.map((event) => event.id)).toEqual(['0', '1'])
    for (const marker of markers)
      expect(marker.x + scale.toX(Date.parse(line.createdAt))).toBeCloseTo(
        scale.toX(Date.parse(marker.events[0]!.at)),
      )
    expect(markers.flatMap((marker) => marker.events)).toEqual(records)
  })
  test('expanding a cluster separates its events and preserves inverse time coordinates', () => {
    const records = [10000, 10001].map((at, index) => ({
      id: String(index),
      lineId: line.id,
      at: new Date(at).toISOString(),
      kind: 'snapshot' as const,
      title: 'Snapshot',
      detail: '',
    }))
    const normal = timelineScale(0, 3600000, [10000, 10001])
    expect(eventMarkers(records, line, 0, 3600000, normal.toX)).toHaveLength(1)
    const expanded = timelineScale(0, 3600000, [10000, 10001], [10000, 10001])
    expect(eventMarkers(records, line, 0, 3600000, expanded.toX)).toHaveLength(2)
    expect(expanded.toX(10001) - expanded.toX(10000)).toBeGreaterThanOrEqual(55)
    expect(expanded.right).toBeGreaterThan(TRACK_END)
    for (const at of [0, 10000, 10000.5, 10001, 1800000, 3600000])
      expect(expanded.toTime(expanded.toX(at))).toBeCloseTo(at)
  })
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

test('screen-space clustering splits on zoom in and regroups on zoom out without losing records', () => {
  const records = [10000, 10036, 10072, 10108].map((at, index) => ({
    id: `zoom-${index}`,
    lineId: line.id,
    at: new Date(at).toISOString(),
    kind: 'snapshot' as const,
    title: 'Snapshot',
    detail: '',
  }))
  const ids = records.map((event) => event.id)
  for (const [zoom, count] of [
    [0.25, 1],
    [1, 2],
    [2, 4],
    [0.25, 1],
  ]) {
    const markers = eventMarkers(records, line, 0, 20000, (at) => at, ids, zoom)
    expect(markers).toHaveLength(count!)
    expect(markers.flatMap((marker) => marker.events)).toEqual(records)
    for (const marker of markers)
      expect(marker.x).toBe(Date.parse(marker.events[0]!.at) - Date.parse(line.createdAt))
  }
})

test('small zoom fluctuations keep the current clustering scale', () => {
  expect(clusterZoom(1, 1.05)).toBe(1)
  expect(clusterZoom(1, 0.95)).toBe(1)
  expect(clusterZoom(1, 1.2)).toBe(1.2)
  expect(clusterZoom(1.2, 1.15)).toBe(1.2)
  expect(clusterZoom(1.2, 1)).toBe(1)
})
