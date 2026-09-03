/**
 * Test doubles for the DSH shell's client (browser) side.
 *
 * A dual-face plugin's browser bundle binds to surfaces that only exist inside
 * the shell page: the `__ModuleLoader__` registry the bundle must announce
 * itself to, the `slots` service that mounts overlay and settings UI, the
 * `sessions` provide channel carrying live agent state, and the `settingsScope`
 * persistence binder. These doubles give a test that same shape in plain Node
 * or jsdom, small enough to read in one sitting — the client counterpart to
 * the host-side doubles in this package.
 *
 * ```ts
 * import { createMockClientRuntime } from '@seaveyon/dsh-plugin-testkit'
 *
 * const runtime = createMockClientRuntime({ modules: { react: React } })
 * const exports = runtime.invokeFactory() // runs the loaded bundle's factory
 * exports.apply(runtime.context)
 * runtime.sessions.publish({ running: true, ... }) // drive agent state
 * ```
 *
 * Nothing here is for production use.
 *
 * @module @seaveyon/dsh-plugin-testkit/client
 */

import type { Disposer } from './types.js'

/** Minimal observable shape shared by the shell's client provide channels. */
export interface ClientObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): Disposer
}

/** A controllable observable: `set` replaces the snapshot and notifies. */
export interface MockObservable<T> extends ClientObservable<T> {
  set(value: T): void
  readonly listeners: ReadonlySet<() => void>
}

/**
 * Create an observable cell.
 *
 * @param initial - the first snapshot.
 */
export function createMockObservable<T>(initial: T): MockObservable<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    listeners,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value) {
      current = value
      // Snapshot: a listener may unsubscribe itself mid-notify.
      for (const listener of Array.from(listeners)) listener()
    },
  }
}

/** One recorded slot registration. */
export interface SlotRegistrationRecord {
  descriptor: Record<string, unknown>
  component: unknown
}

/** The `slots` service double: records instead of mounting. */
export interface MockSlots {
  register(descriptor: Record<string, unknown>, component: unknown): Disposer
  inject(slotName: string, register: () => unknown): void
  /** Registrations per slot name, in registration order. */
  readonly registrations: ReadonlyMap<string, SlotRegistrationRecord[]>
}

/**
 * Create the slots double. `inject` runs its callback synchronously, matching
 * the shell's registration-edge semantics.
 */
export function createMockSlots(): MockSlots {
  const registrations = new Map<string, SlotRegistrationRecord[]>()
  return {
    registrations,
    register(descriptor, component) {
      const name = typeof descriptor['name'] === 'string' ? descriptor['name'] : 'unknown'
      const list = registrations.get(name) ?? []
      const record: SlotRegistrationRecord = { descriptor, component }
      list.push(record)
      registrations.set(name, list)
      return () => {
        const index = list.indexOf(record)
        if (index !== -1) list.splice(index, 1)
      }
    },
    inject(_slotName, register) {
      register()
    },
  }
}

/** The `sessions` service double over the current-session provide channel. */
export interface MockSessions<TSnapshot = unknown> {
  readonly currentProvideInfo: MockObservable<{
    hooks: { session: MockObservable<TSnapshot | null> }
  } | null>
  /** Replace the live ConversationSnapshot (null = no current session). */
  publish(snapshot: TSnapshot | null): void
  /** Replace the current provide bundle (session switch). */
  select(info: { hooks: { session: MockObservable<TSnapshot | null> } } | null): void
}

/**
 * Create the sessions double: `currentProvideInfo` publishes a bundle whose
 * `hooks.session` is an observable of the live conversation snapshot, matching
 * the shell's two-level shape.
 */
export function createMockSessions<TSnapshot = unknown>(
  initial: TSnapshot | null = null,
): MockSessions<TSnapshot> {
  const session = createMockObservable<TSnapshot | null>(initial)
  const currentProvideInfo = createMockObservable<{
    hooks: { session: MockObservable<TSnapshot | null> }
  } | null>({ hooks: { session } })
  return {
    currentProvideInfo,
    publish: (snapshot) => session.set(snapshot),
    select: (info) => currentProvideInfo.set(info),
  }
}

/** One bound namespace of the `settingsScope` double. */
export interface MockSettingsScope {
  getSnapshot(): { status: 'ready'; value: Record<string, unknown> }
  subscribe(listener: () => void): Disposer
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** The `settingsScope` binder double: namespaces over in-memory maps. */
export interface MockSettingsScopeBinder {
  bind(spec: { namespace: string }): MockSettingsScope
  /** Namespaces bound so far, for assertion. */
  readonly bound: ReadonlyMap<string, Record<string, unknown>>
}

/** Create the settingsScope binder double. */
export function createMockSettingsScopeBinder(): MockSettingsScopeBinder {
  const bound = new Map<string, Record<string, unknown>>()
  return {
    bound,
    bind(spec) {
      const store = bound.get(spec.namespace) ?? {}
      bound.set(spec.namespace, store)
      const cell = createMockObservable<{ status: 'ready'; value: Record<string, unknown> }>({
        status: 'ready',
        value: store,
      })
      return {
        getSnapshot: () => cell.getSnapshot(),
        subscribe: (listener) => cell.subscribe(listener),
        set(field, value) {
          store[field] = value
          cell.set({ status: 'ready', value: { ...store } })
          return Promise.resolve()
        },
        unset(field) {
          delete store[field]
          cell.set({ status: 'ready', value: { ...store } })
          return Promise.resolve()
        },
      }
    },
  }
}

/** The `__ModuleLoader__` double: captures `load` calls and stubs `require`. */
export interface MockModuleLoader {
  /** The most recent `{ id, factory }` passed to `load`, if any. */
  readonly loaded: {
    id: string
    factory: (require: (specifier: string) => unknown) => unknown
  } | null
  /** Run the captured factory against the stubbed module table. */
  invokeFactory(): { name?: string; inject?: string[]; apply?: (ctx: unknown) => void }
  /** Install this double as `__ModuleLoader__` on the given global object. */
  install(target: Record<string, unknown>): Disposer
}

/**
 * Create the module-loader double.
 *
 * @param modules - the shell's static module table: what `require(specifier)`
 *   returns. A specifier absent from the table throws, the way the shell's
 *   loader fails loud on undeclared externals.
 */
export function createMockModuleLoader(modules: Record<string, unknown> = {}): MockModuleLoader {
  let loaded: MockModuleLoader['loaded'] = null
  const require = (specifier: string): unknown => {
    if (!(specifier in modules)) {
      throw new Error(`client-modules: module "${specifier}" is not in the static table`)
    }
    return modules[specifier]
  }
  return {
    get loaded() {
      return loaded
    },
    invokeFactory() {
      if (loaded === null) throw new Error('no module was loaded')
      return loaded.factory(require) as {
        name?: string
        inject?: string[]
        apply?: (ctx: unknown) => void
      }
    },
    install(target) {
      const previous = target['__ModuleLoader__']
      target['__ModuleLoader__'] = {
        load(entry: { id: string; factory: (require: (specifier: string) => unknown) => unknown }) {
          loaded = entry
        },
      }
      return () => {
        if (previous === undefined) {
          delete target['__ModuleLoader__']
        } else {
          target['__ModuleLoader__'] = previous
        }
      }
    },
  }
}

/** The client plugin-context double: `get` over a service table. */
export interface MockClientContext {
  get(name: string): unknown
  effect(fn: () => Disposer | void, label?: string): void
  /** Effects registered through `effect`, for lifecycle assertions. */
  readonly effects: readonly { fn: () => Disposer | void; label?: string }[]
}

/** Create the client context double over a service table. */
export function createMockClientContext(services: Record<string, unknown>): MockClientContext {
  const effects: { fn: () => Disposer | void; label?: string }[] = []
  return {
    effects,
    get: (name) => services[name],
    effect(fn, label) {
      effects.push(label === undefined ? { fn } : { fn, label })
    },
  }
}

/** The full client bench: loader, slots, sessions, settings, and context. */
export interface MockClientRuntime<TSnapshot = unknown> {
  readonly loader: MockModuleLoader
  readonly slots: MockSlots
  readonly sessions: MockSessions<TSnapshot>
  readonly settingsScope: MockSettingsScopeBinder
  readonly context: MockClientContext
}

/**
 * Compose the whole client bench in one call.
 *
 * @param options.modules - static module table for the loader's `require`.
 * @param options.initialSnapshot - first ConversationSnapshot, when a session
 *   is current from the start.
 */
export function createMockClientRuntime<TSnapshot = unknown>(
  options: { modules?: Record<string, unknown>; initialSnapshot?: TSnapshot | null } = {},
): MockClientRuntime<TSnapshot> {
  const loader = createMockModuleLoader(options.modules ?? {})
  const slots = createMockSlots()
  const sessions = createMockSessions<TSnapshot>(options.initialSnapshot ?? null)
  const settingsScope = createMockSettingsScopeBinder()
  const context = createMockClientContext({ slots, sessions, settingsScope })
  return { loader, slots, sessions, settingsScope, context }
}
