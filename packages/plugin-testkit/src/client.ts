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

/**
 * The shell's session-list snapshot, as the sidebar plugins read it: which
 * session is current. Extra members the real store carries are permitted
 * because a plugin that ignores them must keep working when they change.
 */
export interface SessionListSnapshot {
  current?: string
  [extra: string]: unknown
}

/**
 * One session's binding, as `sessions.binding(id)` returns it on DSH 0.1.5+:
 * the outward session face is an observable of the session snapshot.
 */
export interface SessionBindingRecord<TFace = unknown> {
  sessionId: string
  session: MockObservable<TFace>
}

/**
 * The `sessions` service double, covering both generations of the shell's
 * live-state surface:
 *
 * - `currentProvideInfo` (DSH ≤ 0.1.2): the two-level provide channel whose
 *   `hooks.session` is an observable of the conversation snapshot;
 * - `list` + `binding(id)` (DSH 0.1.5+): the list store carries `current`,
 *   and `binding(current).session` is an observable of the session snapshot.
 *
 * A plugin that supports one shape runs against a double built with
 * `createMockSessions({ shape: 'provide-info' | 'binding' })`; the default
 * exposes both, so a plugin that probes for either finds what it looks for.
 */
export interface MockSessions<TSnapshot = unknown, TFace = unknown> {
  readonly currentProvideInfo?: MockObservable<{
    hooks: { session: MockObservable<TSnapshot | null> }
  } | null>
  /** The session list store; `getSnapshot().current` is the selected id. */
  readonly list: MockObservable<SessionListSnapshot>
  /** `sessions.binding(id)`: the face bound with `bind`, or undefined. */
  binding?(sessionId: string): SessionBindingRecord<TFace> | undefined
  /** Replace the live ConversationSnapshot (null = no current session). */
  publish(snapshot: TSnapshot | null): void
  /** Replace the current provide bundle (session switch). */
  select(info: { hooks: { session: MockObservable<TSnapshot | null> } } | null): void
  /** Change which session id `list` reports as current (undefined = none). */
  setCurrent(sessionId: string | undefined): void
  /** Publish a session face for `binding(sessionId)`; returns its observable. */
  bind(sessionId: string, initial: TFace): MockObservable<TFace>
  /** Forget a bound face, as the shell does when a session is pruned. */
  unbind(sessionId: string): void
}

/** Which live-state surface(s) the sessions double exposes. */
export type MockSessionsShape = 'both' | 'provide-info' | 'binding'

/**
 * Create the sessions double.
 *
 * @param initial - first ConversationSnapshot on the provide channel.
 * @param currentSessionId - the id `list` reports as current.
 * @param shape - which host generation's surface to expose; defaults to both.
 */
export function createMockSessions<TSnapshot = unknown, TFace = unknown>(
  initial: TSnapshot | null = null,
  currentSessionId?: string,
  shape: MockSessionsShape = 'both',
): MockSessions<TSnapshot, TFace> {
  const session = createMockObservable<TSnapshot | null>(initial)
  const currentProvideInfo = createMockObservable<{
    hooks: { session: MockObservable<TSnapshot | null> }
  } | null>({ hooks: { session } })
  const list = createMockObservable<SessionListSnapshot>(
    currentSessionId === undefined ? {} : { current: currentSessionId },
  )
  const faces = new Map<string, MockObservable<TFace>>()
  const double: MockSessions<TSnapshot, TFace> = {
    list,
    publish: (snapshot) => session.set(snapshot),
    select: (info) => currentProvideInfo.set(info),
    setCurrent(sessionId) {
      const { current: _dropped, ...rest } = list.getSnapshot()
      list.set(sessionId === undefined ? rest : { ...rest, current: sessionId })
    },
    bind(sessionId, value) {
      const face = createMockObservable<TFace>(value)
      faces.set(sessionId, face)
      // The shell bumps the list revision when a session materializes, which
      // is what lets a reader retry `binding()` for an id it saw earlier.
      list.set({ ...list.getSnapshot() })
      return face
    },
    unbind(sessionId) {
      faces.delete(sessionId)
      list.set({ ...list.getSnapshot() })
    },
  }
  if (shape !== 'binding') {
    Object.assign(double, { currentProvideInfo })
  }
  if (shape !== 'provide-info') {
    Object.assign(double, {
      binding(sessionId: string) {
        const face = faces.get(sessionId)
        return face === undefined ? undefined : { sessionId, session: face }
      },
    })
  }
  return double
}

/** One workspace row as the shell's `workspaces.list` store publishes it. */
export interface WorkspaceRecord {
  workspaceId: string
  path?: string
  sessionIds?: string[]
  [extra: string]: unknown
}

/** The `workspaces` service double: an in-memory list with create/delete. */
export interface MockWorkspaces {
  readonly list: MockObservable<{ items: WorkspaceRecord[] }>
  /** Append a workspace for `path` and return it, as the shell does. */
  create(input: { path: string }): Promise<WorkspaceRecord>
  /** Remove a workspace by id; unknown ids reject, as the shell does. */
  delete(workspaceId: string): Promise<void>
  /** Every `create` input, in call order. */
  readonly created: readonly { path: string }[]
  /** Every `delete` id, in call order. */
  readonly deleted: readonly string[]
}

/**
 * Create the workspaces double.
 *
 * @param initial - rows present before the plugin runs.
 * @param nextId - id generator for `create`; defaults to `ws-1`, `ws-2`, …
 */
export function createMockWorkspaces(
  initial: WorkspaceRecord[] = [],
  nextId: (index: number) => string = (index) => `ws-${index}`,
): MockWorkspaces {
  const list = createMockObservable<{ items: WorkspaceRecord[] }>({ items: [...initial] })
  const created: { path: string }[] = []
  const deleted: string[] = []
  let counter = initial.length
  return {
    list,
    created,
    deleted,
    create(input) {
      created.push({ path: input.path })
      counter += 1
      const record: WorkspaceRecord = { workspaceId: nextId(counter), path: input.path }
      list.set({ items: [...list.getSnapshot().items, record] })
      return Promise.resolve(record)
    },
    delete(workspaceId) {
      deleted.push(workspaceId)
      const items = list.getSnapshot().items
      const remaining = items.filter((item) => item.workspaceId !== workspaceId)
      if (remaining.length === items.length) {
        return Promise.reject(new Error(`mock workspaces: unknown workspace ${workspaceId}`))
      }
      list.set({ items: remaining })
      return Promise.resolve()
    },
  }
}

/** The `uiWorkspace` service double: records which session was opened. */
export interface MockUiWorkspace {
  startSession(sessionId: string): void
  /** Every `startSession` id, in call order. */
  readonly started: readonly string[]
}

/** Create the uiWorkspace double. */
export function createMockUiWorkspace(): MockUiWorkspace {
  const started: string[] = []
  return {
    started,
    startSession(sessionId) {
      started.push(sessionId)
    },
  }
}

/** A translate function bound to one namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The `locale` service double: namespaced dictionaries with `{param}`
 * interpolation and an `active` locale a test can switch.
 */
export interface MockLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
  bind(namespace: string): Translate
  getSnapshot(): { active: string }
  subscribe(listener: () => void): Disposer
  /** Switch the active locale and notify subscribers. */
  setActive(locale: string): void
  /** Dictionaries registered so far, by namespace then locale. */
  readonly dictionaries: ReadonlyMap<string, Record<string, Record<string, string>>>
}

/**
 * Create the locale double.
 *
 * Lookup order for `bind(ns)(key)`: the active locale, then a language-only
 * fallback (`zh` for `zh-CN`), then `en`, then the key itself — so a missing
 * translation is visible in the output rather than a thrown error. `{name}`
 * placeholders are replaced from `params`.
 *
 * @param active - the initial active locale; defaults to `en`.
 */
export function createMockLocale(active = 'en'): MockLocale {
  const dictionaries = new Map<string, Record<string, Record<string, string>>>()
  const cell = createMockObservable<{ active: string }>({ active })
  return {
    dictionaries,
    register(namespace, incoming) {
      const existing = dictionaries.get(namespace) ?? {}
      const merged: Record<string, Record<string, string>> = { ...existing }
      for (const [locale, table] of Object.entries(incoming)) {
        merged[locale] = { ...merged[locale], ...table }
      }
      dictionaries.set(namespace, merged)
      cell.set({ active: cell.getSnapshot().active })
      return () => {
        if (dictionaries.get(namespace) === merged) dictionaries.delete(namespace)
      }
    },
    bind(namespace) {
      return (key, params) => {
        const tables = dictionaries.get(namespace) ?? {}
        const current = cell.getSnapshot().active
        const candidates = [current, current.split('-')[0] ?? current, 'en']
        let template = key
        for (const locale of candidates) {
          const hit = tables[locale]?.[key]
          if (hit !== undefined) {
            template = hit
            break
          }
        }
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in params ? String(params[name]) : match,
        )
      }
    },
    getSnapshot: () => cell.getSnapshot(),
    subscribe: (listener) => cell.subscribe(listener),
    setActive(locale) {
      cell.set({ active: locale })
    },
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

/**
 * The client plugin-context double: `get` over a service table, plus the
 * `effect` lifecycle the shell's Cordis context gives a client plugin.
 *
 * `effect` runs its setup immediately — as the host does — and keeps the
 * returned disposer for `dispose`. A double that only recorded the callback
 * would let a plugin whose mount throws pass its tests.
 */
export interface MockClientContext {
  get(name: string): unknown
  effect(fn: () => Disposer | void, label?: string): void
  /** Effects registered through `effect`, in call order, for lifecycle assertions. */
  readonly effects: readonly { fn: () => Disposer | void; label?: string }[]
  /** Disposers the effects returned, in registration order. */
  readonly teardowns: readonly { teardown: Disposer; label: string | undefined }[]
  /** Run every teardown in reverse order, as the host does on disposal. */
  dispose(): void
}

/** Create the client context double over a service table. */
export function createMockClientContext(services: Record<string, unknown>): MockClientContext {
  const effects: { fn: () => Disposer | void; label?: string }[] = []
  const teardowns: { teardown: Disposer; label: string | undefined }[] = []
  return {
    effects,
    teardowns,
    get: (name) => services[name],
    effect(fn, label) {
      effects.push(label === undefined ? { fn } : { fn, label })
      const teardown = fn()
      if (typeof teardown === 'function') teardowns.push({ teardown, label })
    },
    dispose() {
      for (const { teardown } of teardowns.splice(0).toReversed()) teardown()
    },
  }
}

/** The full client bench: loader, slots, sessions, settings, and context. */
export interface MockClientRuntime<TSnapshot = unknown, TFace = unknown> {
  readonly loader: MockModuleLoader
  readonly slots: MockSlots
  readonly sessions: MockSessions<TSnapshot, TFace>
  readonly settingsScope: MockSettingsScopeBinder
  readonly workspaces: MockWorkspaces
  readonly uiWorkspace: MockUiWorkspace
  readonly locale: MockLocale
  readonly context: MockClientContext
}

/**
 * Compose the whole client bench in one call. The context's service table
 * holds every double under the name the shell publishes it as (`slots`,
 * `sessions`, `settingsScope`, `workspaces`, `uiWorkspace`, `locale`), plus
 * anything in `options.services`.
 *
 * @param options.modules - static module table for the loader's `require`.
 * @param options.initialSnapshot - first ConversationSnapshot, when a session
 *   is current from the start.
 * @param options.currentSessionId - the id `sessions.list` reports as current.
 * @param options.sessionsShape - which host generation's live-state surface
 *   `sessions` exposes; defaults to both.
 * @param options.workspaces - workspace rows present from the start.
 * @param options.locale - the initial active locale; defaults to `en`.
 * @param options.services - extra services (or overrides) for the context.
 */
export function createMockClientRuntime<TSnapshot = unknown, TFace = unknown>(
  options: {
    modules?: Record<string, unknown>
    initialSnapshot?: TSnapshot | null
    currentSessionId?: string
    sessionsShape?: MockSessionsShape
    workspaces?: WorkspaceRecord[]
    locale?: string
    services?: Record<string, unknown>
  } = {},
): MockClientRuntime<TSnapshot, TFace> {
  const loader = createMockModuleLoader(options.modules ?? {})
  const slots = createMockSlots()
  const sessions = createMockSessions<TSnapshot, TFace>(
    options.initialSnapshot ?? null,
    options.currentSessionId,
    options.sessionsShape,
  )
  const settingsScope = createMockSettingsScopeBinder()
  const workspaces = createMockWorkspaces(options.workspaces ?? [])
  const uiWorkspace = createMockUiWorkspace()
  const locale = createMockLocale(options.locale)
  const context = createMockClientContext({
    slots,
    sessions,
    settingsScope,
    workspaces,
    uiWorkspace,
    locale,
    ...options.services,
  })
  return { loader, slots, sessions, settingsScope, workspaces, uiWorkspace, locale, context }
}
