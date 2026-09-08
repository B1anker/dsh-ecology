import { useEffect, useSyncExternalStore } from 'react'
import type { Job } from './job-view.js'

let records: Job[] = []
const listeners = new Set<() => void>()
let stream: EventSource | null = null,
  timer: ReturnType<typeof setTimeout> | undefined
let users = 0,
  connected = false
export function jobsConnected() {
  return connected
}
function notify(next: Job[]) {
  records = next
  for (const listener of listeners) listener()
}
function start() {
  if (stream || timer) return
  if (typeof EventSource !== 'undefined') {
    stream = new EventSource('/api/world-line?stream=jobs')
    stream.addEventListener('jobs', (event) => {
      connected = true
      try {
        notify(JSON.parse((event as MessageEvent).data))
      } catch {}
    })
    stream.onopen = () => {
      connected = true
    }
    stream.onerror = () => {
      connected = false
    }
  }
  const poll = async () => {
    if (!connected) {
      try {
        const response = await fetch('/api/world-line', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'jobs' }),
        })
        if (response.ok) notify(await response.json())
      } catch {}
    }
    if (users > 0) timer = setTimeout(() => void poll(), 10000)
  }
  void poll()
}
export function useJobFeed() {
  useEffect(() => {
    users++
    start()
    return () => {
      if (--users === 0) {
        stream?.close()
        stream = null
        connected = false
        clearTimeout(timer)
        timer = undefined
      }
    }
  }, [])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => records,
  )
}
