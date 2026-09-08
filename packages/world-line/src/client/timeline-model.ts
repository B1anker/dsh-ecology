import type { WorldEvent } from '../domain/insight-types.js'

export interface Line {
  id: string
  initialization?: 'clean'
  completedAt?: string
  alias?: string
  parentId?: string
  snapshotId?: string
  forkedAt?: string
  createdAt: string
  kind: string
  state: string
  verdict: string | null
  port?: number
  isDefault: boolean
}
export const label = (line: Line) => line.alias ?? `wl-${line.id.slice(-8)}`
export const stateLabel = (state: string) =>
  ({
    running: '运行中',
    stopped: '已停止',
    failed: '失败',
    passed: '验证已完成',
    incomplete: '验证未完成',
    review: '异常待确认',
    awaiting_auth: '等待登录',
    applying: '准备中',
    created: '已创建',
    unreachable: '连接失效',
  })[state] ?? state
export const TRACK_LEFT = 48
export const TRACK_END = 820
export const ROW_HEIGHT = 90
export const timeX = (at: number, start: number, end: number) =>
  TRACK_LEFT +
  Math.max(0, Math.min(1, (at - start) / Math.max(1, end - start))) * (TRACK_END - TRACK_LEFT)

/** Piecewise time mapping: preserve event order while bounding empty spans. */
export function timelineScale(start: number, end: number, instants: number[]) {
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
    offset += (segment.weight / total) * (TRACK_END - TRACK_LEFT)
    return { ...segment, left, right: offset }
  })
  const toX = (at: number) => {
    at = Math.max(start, Math.min(end, at))
    const s = mapped.find((segment) => at <= segment.to)!
    return s.left + ((at - s.from) / s.duration) * (s.right - s.left)
  }
  const toTime = (x: number) => {
    x = Math.max(TRACK_LEFT, Math.min(TRACK_END, x))
    const s = mapped.find((segment) => x <= segment.right) ?? mapped[mapped.length - 1]!
    return s.from + ((x - s.left) / (s.right - s.left)) * s.duration
  }
  return { toX, toTime, compressed, gaps: mapped.filter((s) => s.duration > 6 * hour) }
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
export function eventMarkers(
  events: WorldEvent[],
  line: Line,
  start: number,
  end: number,
  toX = (at: number) => timeX(at, start, end),
) {
  const markers: { x: number; events: WorldEvent[] }[] = []
  const born = toX(Date.parse(line.createdAt))
  for (const event of events
    .filter((item) => item.lineId === line.id)
    .toSorted((a, b) => a.at.localeCompare(b.at))) {
    const x = toX(Date.parse(event.at)) - born
    const last = markers.at(-1)
    if (last && x - last.x < 20) last.events.push(event)
    else markers.push({ x, events: [event] })
  }
  return markers
}
// Vivid light-trail palette from the supplied reference. IDs keep colors stable.
const linePalette = [
  '#e83e52',
  '#269b68',
  '#ed940a',
  '#d62cb7',
  '#00b6c8',
  '#5254e8',
  '#bd693b',
  '#8e4bdb',
  '#008f91',
  '#db587a',
  '#587fdf',
  '#99a51b',
  '#c7511f',
  '#ba4290',
  '#43783e',
  '#a17a24',
  '#8364ed',
  '#df6942',
  '#208dc3',
  '#cc4570',
  '#3f9c87',
  '#8d69a8',
  '#b29317',
  '#4969a5',
]
export function lineColor(id: string) {
  if (id === 'origin') return '#00dedf'
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return linePalette[hash % linePalette.length]!
}
