/**
 * A Cordis-like plugin context.
 *
 * Enough of the real thing for a plugin's `apply` to run: services to `get`,
 * `effect` to collect teardowns, a logger that records rather than prints,
 * `set`/`provide` for anything the plugin publishes, and `on`/`emit`/`waterfall`
 * for hook plugins. What it adds beyond the real context is inspection — the
 * teardowns, the log lines, and the listener table are readable afterwards.
 *
 * @module @seaveyon/dsh-plugin-testkit/context
 */

import { createEventBus, type ListenerMap } from './events.js'
import type { ContextListener, Disposer, Logger, PluginContext } from './types.js'

/** What the plugin logged, split by level. */
export interface CapturedLogs {
  info: string[]
  warn: string[]
}

/** A registered teardown and the label the plugin gave it. */
export interface CapturedTeardown {
  teardown: Disposer
  label: string | undefined
}

/** Availability probe installed through {@link MockContext.provide}. */
interface ProvidedEntry {
  value: unknown
  available: (() => boolean) | undefined
}

/** The mock context, plus the state a test inspects afterwards. */
export interface MockContext extends PluginContext {
  teardowns: CapturedTeardown[]
  logs: CapturedLogs
  /** Listener table shared with `on` / `emit` / `waterfall`. */
  listeners: ListenerMap
  on: (event: string, listener: ContextListener) => Disposer
  emit: (event: string, ...args: unknown[]) => void
  waterfall: (event: string, ...args: unknown[]) => unknown
  provide: (name: string, value: unknown, available?: () => boolean) => void
  set: (name: string, value: unknown) => void
  /** Run every teardown in reverse order, as Cordis does on disposal. */
  dispose: () => void
}

/**
 * Create a context sufficient for a plugin's use of one.
 * @param services - services the plugin will `get`; also where `set` writes.
 * @returns the context, plus the collected teardown callbacks and log lines.
 */
export function createMockContext(services: Record<string, unknown>): MockContext {
  const teardowns: CapturedTeardown[] = []
  const logs: CapturedLogs = { info: [], warn: [] }
  const provided = new Map<string, ProvidedEntry>()
  const bus = createEventBus()
  const logger: Logger = {
    info: (line) => logs.info.push(line),
    warn: (line) => logs.warn.push(line),
  }

  return {
    get<T>(name: string): T | undefined {
      const entry = provided.get(name)
      if (entry !== undefined) {
        if (entry.available !== undefined && !entry.available()) return undefined
        return entry.value as T
      }
      return services[name] as T | undefined
    },
    effect(setup, label) {
      const teardown = setup()
      if (typeof teardown === 'function') teardowns.push({ teardown, label })
    },
    set(name, value) {
      provided.delete(name)
      services[name] = value
    },
    provide(name, value, available) {
      delete services[name]
      provided.set(name, { value, available })
    },
    on(event, listener) {
      const dispose = bus.on(event, listener as (...args: never[]) => unknown)
      teardowns.push({ teardown: dispose, label: `on:${event}` })
      return dispose
    },
    emit(event, ...args) {
      bus.emit(event, ...args)
    },
    waterfall(event, ...args) {
      return bus.waterfall(event, ...args)
    },
    logger,
    teardowns,
    logs,
    listeners: bus.listeners,
    dispose() {
      for (const { teardown } of [...teardowns].toReversed()) teardown()
    },
  }
}
