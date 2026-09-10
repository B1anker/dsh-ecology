import type { WorldEvent } from '../domain/insight-types.js'
import type { WorldLineInfo } from '../web/types.js'
import { lineStateText } from './status-text.js'

// forkedAt 由后端在 lines 响应上动态附加（web/index.ts），WorldLineInfo 未声明。
export interface Line extends WorldLineInfo {
  forkedAt?: string
}
export const label = (line: Line) => line.alias ?? `wl-${line.id.slice(-8)}`
export const stateLabel = lineStateText
export const TRACK_LEFT = 48
export const TRACK_END = 820
export const ROW_HEIGHT = 90
/** A restore is an appended operation; its target must be an actual snapshot on this line. */
export function restoreRelation(events: WorldEvent[], lineId: string) {
  const history = events.filter((event) => event.lineId === lineId)
  const restore = history
    .filter((event) => event.kind === 'restore')
    .toSorted((a, b) => b.at.localeCompare(a.at))[0]
  if (!restore) return null
  const target = history.find(
    (event) => event.kind === 'snapshot' && event.snapshotId === restore.snapshotId,
  )
  if (!target || Date.parse(target.at) > Date.parse(restore.at)) return null
  return {
    restore,
    target,
    later: history.some((event) => Date.parse(event.at) > Date.parse(restore.at)),
  }
}
/** A missing parent still gets a visual anchor; never rewrite the operational source. */
export function canvasConnections(lines: Line[]) {
  const ids = new Set(lines.map((line) => line.id))
  return lines.flatMap((line) => {
    if (line.id === 'origin') return []
    const parent = line.parentId ?? 'origin'
    const missing = parent === line.id || !ids.has(parent)
    const source = missing ? 'origin' : parent
    return ids.has(source) ? [{ source, target: line.id, missing }] : []
  })
}
export const timeX = (at: number, start: number, end: number) =>
  TRACK_LEFT +
  Math.max(0, Math.min(1, (at - start) / Math.max(1, end - start))) * (TRACK_END - TRACK_LEFT)

/** Piecewise time mapping: preserve event order while bounding empty spans. */
export function timelineScale(
  start: number,
  end: number,
  instants: number[],
  focus: number[] = [],
) {
  end = Math.max(start + 1, end)
  const hour = 3600000
  const anchors = [
    ...new Set([
      start,
      end,
      ...instants.filter((at) => Number.isFinite(at) && at > start && at < end),
    ]),
  ].sort((a, b) => a - b)
  const compressed = anchors.some((at, i) => i > 0 && at - anchors[i - 1]! > 6 * hour)
  const segments = anchors.slice(1).map((to, i) => {
    const from = anchors[i]!,
      duration = to - from
    return {
      from,
      to,
      duration,
      weight: compressed ? Math.max(hour / 4, Math.min(6 * hour, duration)) : duration,
    }
  })
  const total = segments.reduce((sum, segment) => sum + segment.weight, 0)
  let offset = TRACK_LEFT
  const mapped = segments.map((segment) => {
    const left = offset
    const width = (segment.weight / total) * (TRACK_END - TRACK_LEFT)
    const expanded = focus.some((at) => at === segment.from || at === segment.to)
    offset += expanded ? Math.max(56, width) : width
    return { ...segment, left, right: offset }
  })
  const toX = (at: number) => {
    at = Math.max(start, Math.min(end, at))
    const s = mapped.find((segment) => at <= segment.to)!
    return s.left + ((at - s.from) / s.duration) * (s.right - s.left)
  }
  const toTime = (x: number) => {
    x = Math.max(TRACK_LEFT, Math.min(offset, x))
    const s = mapped.find((segment) => x <= segment.right) ?? mapped[mapped.length - 1]!
    return s.from + ((x - s.left) / (s.right - s.left)) * s.duration
  }
  return {
    toX,
    toTime,
    right: offset,
    compressed,
    gaps: mapped.filter((s) => s.duration > 6 * hour),
  }
}
export function pointTime(x: number, line: Line, start: number, end: number) {
  const at = start + ((x - TRACK_LEFT) / (TRACK_END - TRACK_LEFT)) * (end - start)
  return Math.min(end, Math.max(Date.parse(line.createdAt), at))
}
// An in-flight create can already appear in a poll before its startup response arrives.
// The submitted alias is immutable then; the server remains the uniqueness authority.
export function aliasValidation(alias: string, lines: Line[], editingId?: string, pending = false) {
  if (pending) return ''
  if (!alias.trim()) return '请输入世界线别名'
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || alias.startsWith('lab-'))
    return '使用 1–64 位字母、数字、下划线或短横线，不能以 lab- 开头。'
  return lines.some((line) => line.alias === alias && line.id !== editingId)
    ? '这个别名已被使用，请换一个。'
    : ''
}

// Store an instant, not a percentage: polling can advance now without moving a historical cursor.
export const cursorTime = (cursor: number | null, now: number) => cursor ?? now
export function adjacentEvent(events: WorldEvent[], at: number, direction: -1 | 1) {
  const ordered = events.toSorted(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  )
  return direction === -1
    ? ordered.findLast((event) => Date.parse(event.at) < at)
    : ordered.find((event) => Date.parse(event.at) > at)
}
/** Ignore small zoom fluctuations so clusters do not chatter during a pinch. */
export function clusterZoom(previous: number, next: number) {
  return Math.abs(Math.log(next / previous)) >= Math.log(1.1) ? next : previous
}

export function eventMarkers(
  events: WorldEvent[],
  line: Line,
  start: number,
  end: number,
  toX = (at: number) => timeX(at, start, end),
  expandedIds: string[] = [],
  zoom = 1,
) {
  const markers: { x: number; events: WorldEvent[] }[] = []
  const born = toX(Date.parse(line.createdAt))
  // 24 flow-unit node diameter plus breathing room, with a 40px screen floor.
  const minimumGap = Math.max(32, 40 / Math.max(0.25, zoom))
  for (const event of events
    .filter(
      (item) =>
        item.lineId === line.id &&
        (!item.parentEventId ||
          expandedIds.includes(item.id) ||
          events.some(
            (event) =>
              event.lineId === line.id &&
              event.kind === 'restore' &&
              event.snapshotId === item.snapshotId,
          )),
    )
    .toSorted((a, b) => a.at.localeCompare(b.at))) {
    const x = toX(Date.parse(event.at)) - born
    const last = markers.at(-1)
    if (last && x - last.x < minimumGap) last.events.push(event)
    else markers.push({ x, events: [event] })
  }
  return markers
}
// Vivid light-trail palette from the supplied reference. IDs keep colors stable.
const linePalette = [
  '#268bcc',
  '#13a4bc',
  '#557ce0',
  '#8b75db',
  '#21a99e',
  '#458ccf',
  '#5470c6',
  '#996fc5',
  '#178caa',
  '#499db7',
  '#667cce',
  '#379abf',
  '#587ee1',
  '#2b9da5',
  '#7186c9',
  '#427fc2',
  '#877bd4',
  '#459fb0',
  '#208dc3',
  '#6d83c0',
  '#32a59f',
  '#7684d5',
  '#2999d0',
  '#496fae',
]
export function lineColor(id: string) {
  if (id === 'origin') return '#00dedf'
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return linePalette[hash % linePalette.length]!
}

/** Leave the source's right edge horizontally and enter the target vertically. */
export function mergeConnectionPath(fromX: number, fromY: number, nodeX: number, nodeY: number) {
  const direction = nodeY < fromY ? -1 : 1
  const startX = fromX + 14
  const departureX = startX + 8
  const span = nodeX - startX
  const endY = nodeY - direction * 16
  const rise = Math.abs(endY - fromY)
  if (span > 8 && rise > 0) {
    // Keep the long lead on the source rail, then use a broad quarter ellipse.
    // Its horizontal departure and vertical arrival stay smooth at any span.
    const radiusX = Math.min(span - 8, rise * 1.6)
    const turnX = nodeX - radiusX
    return `M ${startX} ${fromY} L ${turnX} ${fromY} A ${radiusX} ${rise} 0 0 ${direction < 0 ? 0 : 1} ${nodeX} ${endY}`
  }
  const stem = Math.min(12, Math.abs(endY - fromY) / 4)
  const arrivalY = endY - direction * stem
  const middleY = (fromY + endY) / 2
  const bend = Math.max(16, Math.min(48, Math.abs(nodeX - startX) / 2))
  return `M ${startX} ${fromY} L ${departureX} ${fromY} C ${departureX + bend} ${fromY}, ${nodeX} ${middleY}, ${nodeX} ${arrivalY} L ${nodeX} ${endY}`
}
