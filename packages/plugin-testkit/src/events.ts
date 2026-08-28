/**
 * Cordis-like event dispatch used by the mock context.
 *
 * Small on purpose: enough to drive `emit` and `waterfall` the way a hook
 * plugin calls them, without becoming a second Cordis. Waterfall semantics
 * match the Cordis primer — a listener receives `(…payload, next)` and must
 * call `next()` to delegate; returning without it short-circuits.
 *
 * @module @seaveyon/dsh-plugin-testkit/events
 */

import type { Disposer } from './types.js'

/** A listener registered with {@link EventBus.on}. */
export type EventListener = (...args: never[]) => unknown

/** Around-middleware form for waterfall listeners. */
export type WaterfallListener = (...args: [...unknown[], () => unknown]) => unknown

/** Mutable listener table a test can inspect. */
export type ListenerMap = Map<string, EventListener[]>

/**
 * Run a waterfall over a fixed listener list.
 *
 * When every listener has delegated, `terminal` runs. That is how
 * `tools/execute` bottoms out in the tool body and `tools/post-execute`
 * bottoms out in the candidate result.
 *
 * @param list - listeners in registration order.
 * @param args - payload forwarded ahead of `next`.
 * @param terminal - value (or thunk result) when the chain is exhausted.
 * @returns whatever the first listener — or the terminal — returns.
 */
export function runWaterfall(
  list: readonly EventListener[],
  args: readonly unknown[],
  terminal: () => unknown = () => undefined,
): unknown {
  let index = 0

  const next = (): unknown => {
    const listener = list[index]
    index += 1
    if (listener === undefined) return terminal()
    return (listener as WaterfallListener)(...args, next)
  }

  return next()
}

/**
 * Create an empty listener table and the dispatch helpers that share it.
 * @returns the table plus `on` / `emit` / `waterfall`.
 */
export function createEventBus(): {
  listeners: ListenerMap
  on: (event: string, listener: EventListener) => Disposer
  emit: (event: string, ...args: unknown[]) => void
  waterfall: (event: string, ...args: unknown[]) => unknown
} {
  const listeners: ListenerMap = new Map()

  return {
    listeners,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event)
        if (current === undefined) return
        const index = current.indexOf(listener)
        if (index === -1) return
        current.splice(index, 1)
        if (current.length === 0) listeners.delete(event)
      }
    },
    emit(event, ...args) {
      const list = listeners.get(event)
      if (list === undefined) return
      // Snapshot: a listener may dispose itself mid-emit.
      for (const listener of list.slice()) {
        ;(listener as (...a: unknown[]) => unknown)(...args)
      }
    },
    waterfall(event, ...args) {
      return runWaterfall(listeners.get(event) ?? [], args)
    },
  }
}
