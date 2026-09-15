/**
 * Hand-written types for the DSH shell client services this plugin binds to.
 *
 * The shell's own packages (`@deepseek-ai/dsh-client-*`, `dsh-api-*`) are
 * optional peers this package never imports, so these declarations are written
 * from the shipped declarations and the observed runtime contract — the same
 * trade-off `packages/web-login/src/types.ts` makes for the host side, and the
 * same rule applies: `scripts/check-host-contract.mjs` re-verifies the members
 * named here against every installed host copy it can find.
 *
 * Contract facts verified against DSH 0.1.1-rc.2 (M0 spike, 2026-09-02):
 *
 * - Discovery: the client module system (`dsh-client-modules`) scans the host
 *   Loader's ACTIVE entries for packages declaring `dsh.client` — a plain
 *   profile dependency is never served. The bundle's `cordis.patch.yml` insert
 *   row is therefore load-bearing, and the host entry (`src/index.ts`) must be
 *   a loadable Cordis plugin.
 * - Serving: the bundle is read from the package's `exports["./client"]` and
 *   served at `/plugins/<entry-name>/client.js?rev=<sha1-12>`, where the entry
 *   name is the scoped package name (`@seaveyon/dsh-pet`), slashes included.
 * - Envelope: the bundle must call `window.__ModuleLoader__.load({ id, factory
 *   })` once; `factory(require)` returns `{ name, inject, apply }` and `require`
 *   resolves shell-provided packages (react) plus `dsh.client.external` rows.
 * - Slots: `slots.inject("shell.overlay" | "settings.section", () =>
 *   slots.register(descriptor, Component))`; descriptors carry
 *   `{ name, id, order, locale?, label? }`.
 * - Live state, DSH ≤ 0.1.2: `sessions.currentProvideInfo` is a HostObservable
 *   whose value's `hooks.session` is itself an observable of
 *   `ConversationSnapshot` (`dsh-client-runtime/.../sessions/conversation.d.ts`).
 *   {@link ConversationSnapshotSlice} is abridged to the members the mood
 *   derivation reads.
 * - Settings: `settingsScope` (a SettingsScopeBinder) exists on this version;
 *   `bind({ namespace })` returns a scope with `getSnapshot`/`subscribe`/
 *   `set(field, value)`/`unset(field)`. Settings RPCs are loopback-only, so a
 *   browser on a remote host gets a process-local (memory) scope — config falls
 *   back to localStorage there.
 *
 * Contract facts read from the DSH 0.1.5-rc.1 declarations (2026-09-15;
 * `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/*.d.ts`):
 *
 * - `dsh-client-runtime` no longer exists and `sessions.currentProvideInfo`
 *   is gone with it. `ctx.sessions` is now `ISessions`: `list` is an
 *   `ObservableSnapshot<SessionListState>` whose `current` is the selected
 *   session id and whose `byId[id].running` mirrors the row's running bit;
 *   `binding(id)` returns `{ sessionId, session }` where `session` is a
 *   `SessionFace = ISession & ObservableSnapshot<SessionSnapshot>`.
 * - `SessionSnapshot` carries `running`, `promptError`, `lastAgentError`,
 *   `queue`, and `pendingSubmissions`; the conversation-level members the
 *   ≤ 0.1.2 slice read (`runningCalls`, `pending`, `turnEnds`) moved into the
 *   conversation assembly and are not exposed on the session face.
 *   {@link SessionSnapshotSlice} is abridged accordingly, and the mood source
 *   synthesizes the missing members (see `mood-source.ts`).
 */

/** Minimal observable shape the shell's provide channels expose. */
export interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The slice of ConversationSnapshot the mood derivation reads. */
export interface ConversationSnapshotSlice {
  running: boolean
  runningCalls: readonly { name: string }[]
  pending: readonly unknown[]
  promptError: unknown | null
  lastAgentError: string | null
  turnEnds: ReadonlyMap<number, number>
  turnTimings: ReadonlyMap<number, { readonly startTime: number; readonly endTime?: number }>
}

/** The current-session provide bundle: `hooks.session` mirrors the snapshot. */
export interface SessionMaybeProvideInfo {
  hooks?: {
    session?: Observable<ConversationSnapshotSlice | null>
  }
}

/** Registration descriptor accepted by `slots.register`. */
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => Record<string, unknown>
}

/** The shell slot registry (the pet contributes a `settings.section`). */
export interface SlotsService {
  register(descriptor: SlotRegistration, component: unknown): () => void
  inject(slotName: string, register: () => unknown): void
}

/** The slice of DSH 0.1.5+ `SessionSnapshot` the mood derivation reads. */
export interface SessionSnapshotSlice {
  running: boolean
  promptError?: unknown | null
  lastAgentError?: string | null
}

/** One row of DSH 0.1.5+ `SessionListState.byId`, abridged. */
export interface SessionSummarySlice {
  running?: boolean
}

/** DSH 0.1.5+ `SessionListState`, abridged to what the mood source reads. */
export interface SessionListStateSlice {
  current?: string
  byId?: Readonly<Record<string, SessionSummarySlice | undefined>>
}

/** DSH 0.1.5+ `SessionBinding`, abridged: the observable session face. */
export interface SessionBindingSlice {
  sessionId: string
  session: Observable<SessionSnapshotSlice>
}

/**
 * Root-scope session service: live agent state. Both host generations are
 * declared optional so the mood source can probe for whichever the running
 * shell provides and degrade quietly on one that provides neither.
 */
export interface SessionsService {
  /** DSH ≤ 0.1.2: the current-session provide channel. */
  currentProvideInfo?: Observable<SessionMaybeProvideInfo | null>
  /** DSH 0.1.5+: the list store carrying the current selection. */
  list?: Observable<SessionListStateSlice>
  /** DSH 0.1.5+: the observable face of one listed session. */
  binding?: (sessionId: string) => SessionBindingSlice | undefined
}

/** One bound settings namespace (DSH settings transport). */
export interface BoundSettingsScope {
  getSnapshot(): { status: string; value?: unknown }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** DSH settings persistence binder (`ctx.settingsScope`). */
export interface SettingsScopeBinder {
  bind(options: { namespace: string }): BoundSettingsScope
}

/** The plugin context handed to `apply`, structurally. */
export interface ClientContext {
  get(name: 'slots'): SlotsService | undefined
  get(name: 'sessions'): SessionsService | undefined
  get(name: 'settingsScope'): SettingsScopeBinder | undefined
  get(name: 'locale'): unknown
  get(name: string): unknown
  effect?(fn: () => (() => void) | void, label?: string): void
}
