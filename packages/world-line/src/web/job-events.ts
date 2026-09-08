import { randomBytes } from 'node:crypto'
import { type JobScope, listJobs } from './jobs.js'

type Event = { id: string; data: string }
type Stream = { revision: string; events: Event[]; bytes: number; sequence: number }
const streams = new Map<string, Stream>(),
  epoch = randomBytes(8).toString('hex')
/** Bounded state replay. Unknown cursors (including server restart) reset to a durable snapshot. */
export function jobEvents(scope: Pick<JobScope, 'home' | 'profileName'>, after?: string): Event[] {
  const key = `${scope.home}\0${scope.profileName}`
  let stream = streams.get(key)
  if (!stream) {
    stream = { revision: '', events: [], bytes: 0, sequence: 0 }
    streams.set(key, stream)
  }
  const records = listJobs(scope).slice(0, 200)
  const revision = records.map((j) => `${j.id}:${j.revision}`).join(',')
  if (revision !== stream.revision || !stream.events.length) {
    stream.revision = revision
    const event = { id: `${epoch}:${++stream.sequence}`, data: JSON.stringify(records) }
    stream.events.push(event)
    stream.bytes += event.data.length
    while (
      stream.events.length > 1 &&
      (stream.events.length > 128 || stream.bytes > 2 * 1024 * 1024)
    )
      stream.bytes -= stream.events.shift()!.data.length
  }
  if (after) {
    const index = stream.events.findIndex((e) => e.id === after)
    if (index >= 0) return stream.events.slice(index + 1)
  }
  return stream.events.slice(-1)
}
