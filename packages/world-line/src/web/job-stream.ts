import type { ServerResponse } from 'node:http'

/** A disconnected/slow observer must never end the job or crash the host. */
export function openJobStream(
  res: ServerResponse,
  events: () => { id: string; data: string }[],
  subscribe: (publish: () => void) => () => void,
  rejected: () => boolean,
) {
  let closed = false
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe()
  }
  const usable = () => !closed && !res.destroyed && !res.writableEnded && !res.writableFinished
  const end = () => {
    cleanup()
    if (!res.destroyed && !res.writableEnded) res.end()
  }
  const write = (chunk: string) => {
    if (!usable()) {
      cleanup()
      return false
    }
    try {
      if (!res.write(chunk)) {
        end()
        return false
      }
      return usable()
    } catch {
      end()
      return false
    }
  }
  const publish = () => {
    if (!usable()) {
      cleanup()
      return
    }
    try {
      for (const event of events())
        if (!write(`id: ${event.id}\nevent: jobs\ndata: ${event.data}\n\n`)) return
    } catch {
      end()
    }
  }
  // Install before the first write: stream errors can be emitted asynchronously.
  res.on('error', cleanup)
  res.once('close', cleanup)
  res.once('finish', cleanup)
  unsubscribe = subscribe(publish)
  publish()
  if (!write(': connected\n\n')) return cleanup
  heartbeat = setInterval(() => {
    if (!usable()) {
      cleanup()
      return
    }
    if (rejected()) {
      end()
      return
    }
    publish()
    write(': heartbeat\n\n')
  }, 10000)
  return cleanup
}
