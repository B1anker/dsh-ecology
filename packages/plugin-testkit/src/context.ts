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
import type { Awaitable } from './harness.js'
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

/** A service published through {@link MockContext.provide}. */
interface ProvidedEntry {
  value: unknown
  /** The availability predicate handed to `provide`, when one was. */
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
  provide: (name: string, value: unknown, available?: () => boolean) => Disposer
  set: (name: string, value: unknown) => void
  /**
   * Whether a dependent injecting `name` would be allowed to load right now.
   *
   * Mirrors how Cordis consults the third `provide` argument: the predicate
   * gates *dependents*, not `get` — `ctx.get` still returns the value of a
   * provided-but-unavailable service, exactly as `reflect.get` does. A
   * predicate that throws counts as unavailable, as it does in the host, and
   * the error is recorded in `logs.warn`. Services from the constructor table
   * are always available. Inspection-only: the real context has no such
   * member.
   */
  available: (name: string) => boolean
  /** Run every teardown in reverse order, as Cordis does on disposal. */
  dispose: () => Promise<void>
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
  let disposed = false
  const logger: Logger = {
    info: (line) => logs.info.push(line),
    warn: (line) => logs.warn.push(line),
  }

  return {
    get<T>(name: string): T | undefined {
      const entry = provided.get(name)
      if (entry !== undefined) {
        return entry.value as T
      }
      return services[name] as T | undefined
    },
    effect(setup, label) {
      const teardown = setup()
      if (typeof teardown === 'function') teardowns.push({ teardown, label })
    },
    set(name, value) {
      const entry = provided.get(name)
      if (entry === undefined) {
        throw new Error(`mock context: cannot set unprovided service ${JSON.stringify(name)}`)
      }
      entry.value = value
    },
    provide(name, value, available) {
      if (provided.has(name) || Object.hasOwn(services, name)) {
        throw new Error(`mock context: service ${JSON.stringify(name)} is already provided`)
      }
      const entry: ProvidedEntry = { value, available }
      provided.set(name, entry)
      let active = true
      const dispose: Disposer = () => {
        if (!active) return
        active = false
        if (provided.get(name) === entry) provided.delete(name)
      }
      teardowns.push({ teardown: dispose, label: `provide:${name}` })
      return dispose
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
    available(name) {
      const entry = provided.get(name)
      if (entry === undefined) return Object.hasOwn(services, name)
      if (entry.available === undefined) return true
      try {
        return entry.available.call(entry.value) === true
      } catch (error) {
        logs.warn.push(
          `availability predicate for ${JSON.stringify(name)} threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return false
      }
    },
    logger,
    teardowns,
    logs,
    listeners: bus.listeners,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const { teardown } of [...teardowns].toReversed()) {
        await (teardown() as Awaitable<void>)
      }
      teardowns.length = 0
    },
  }
}
