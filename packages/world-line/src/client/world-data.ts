/** Ignore unfinished or damaged events before date/coordinate rendering. */
export function validWorldEvents<T extends { at: string }>(events: T[]): T[] {
  return events.filter((event) => Number.isFinite(Date.parse(event.at)))
}

/** Apply a response only to the snapshot whose revision was requested. */
export function mergeWorldResponse(previous: any, incoming: any, requestedRevision?: string) {
  if (!incoming || typeof incoming !== 'object') throw new Error('世界线响应无效，已保留画布')
  if (incoming.unchanged || incoming.delta) {
    if (!previous || previous.revision !== requestedRevision)
      throw new Error('世界线版本已变化，请重新读取')
    if (incoming.unchanged) return { ...previous, now: incoming.now, revision: incoming.revision }
    const merge = (rows: any[], change: any) => {
      if (!Array.isArray(rows) || !Array.isArray(change?.remove) || !Array.isArray(change?.upsert))
        throw new Error('世界线增量不完整，已保留画布')
      const next = new Map(rows.map((row) => [row.id, row]))
      change.remove.forEach((id: string) => next.delete(id))
      change.upsert.forEach((row: any) => next.set(row.id, row))
      return [...next.values()]
    }
    const { delta, ...metadata } = incoming
    return {
      ...previous,
      ...metadata,
      lines: merge(previous.lines, delta.lines),
      events: validWorldEvents(merge(previous.events, delta.events)),
    }
  }
  if (!Array.isArray(incoming.lines) || !Array.isArray(incoming.events))
    throw new Error('世界线数据不完整，已保留画布')
  return { ...incoming, events: validWorldEvents(incoming.events) }
}
