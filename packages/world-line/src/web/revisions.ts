import { sha256Hex } from '../fs/hash.js'

type Row = { id: string }
type Snapshot = { lines: Row[]; events: Row[]; now: string; [key: string]: unknown }
const histories = new Map<string, Map<string, Snapshot>>()
export function revisionResponse<T extends Snapshot>(key: string, data: T, since?: string | null) {
  const revision = sha256Hex(JSON.stringify({ ...data, now: undefined }))
  let history = histories.get(key)
  if (!history) {
    history = new Map()
    histories.set(key, history)
  }
  const previous = since ? history.get(since) : undefined
  history.set(revision, data)
  while (history.size > 8) history.delete(history.keys().next().value!)
  if (since === revision) return { unchanged: true, revision, now: data.now }
  if (!previous) return { ...data, revision }
  const diff = (before: Row[], after: Row[]) => {
    const beforeMap = new Map(before.map((row) => [row.id, JSON.stringify(row)])),
      ids = new Set(after.map((row) => row.id))
    return {
      upsert: after.filter((row) => beforeMap.get(row.id) !== JSON.stringify(row)),
      remove: before.filter((row) => !ids.has(row.id)).map((row) => row.id),
    }
  }
  const { lines, events, ...metadata } = data
  return {
    ...metadata,
    revision,
    delta: { lines: diff(previous.lines, lines), events: diff(previous.events, events) },
  }
}
