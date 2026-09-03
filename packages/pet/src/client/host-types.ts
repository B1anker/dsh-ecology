/**
 * Hand-written types for the DSH shell client services this plugin binds to.
 *
 * The shell's own packages (`@deepseek-ai/dsh-client-*`) are not on the public
 * registry, so these declarations are written from the observed runtime
 * contract — the same trade-off `packages/web-login/src/types.ts` makes for the
 * host side, and the same rule applies: `scripts/check-host-contract.mjs`
 * re-verifies the members named here whenever the real packages are installed.
 *
 * Contract facts verified against DSH 0.1.1-rc.2 (M0 spike, 2026-09-02):
 *
 * - Discovery: the client module system (`dsh-client-modules`) scans the host
 *   Loader's ACTIVE entries for packages declaring `dsh.client` — a plain
 *   profile dependency is never served. The bundle's `cordis.patch.yml` insert
 *   row is therefore load-bearing, and the host entry (`src/index.ts`) must be
 *   a loadable (here: no-op) Cordis plugin.
 * - Serving: the bundle is read from the package's `exports["./client"]` and
 *   served at `/plugins/<entry-name>/client.js?rev=<sha1-12>`, where the entry
 *   name is the scoped package name (`@seaveyon/dsh-pet`), slashes included.
 * - Envelope: the bundle must call `window.__ModuleLoader__.load({ id, factory
 *   })` once; `factory(require)` returns `{ name, inject, apply }` and `require`
 *   resolves shell-provided packages (react) plus `dsh.client.external` rows.
 * - Slots: `slots.inject("shell.overlay" | "settings.section", () =>
 *   slots.register(descriptor, Component))`; descriptors carry
 *   `{ name, id, order, locale?, label? }`.
 * - Live state: `sessions.currentProvideInfo` is a HostObservable whose value's
 *   `hooks.session` is itself an observable of `ConversationSnapshot`. The
 *   snapshot's own type below is abridged from the host's shipped declarations
 *   (`dsh-client-runtime/.../sessions/conversation.d.ts`) — only the members
 *   the mood derivation reads.
 * - Settings: `settingsScope` (a SettingsScopeBinder) exists on this version;
 *   `bind({ namespace })` returns a scope with `getSnapshot`/`subscribe`/
 *   `set(field, value)`/`unset(field)`. Settings RPCs are loopback-only, so a
 *   browser on a remote host gets a process-local (memory) scope — config falls
 *   back to localStorage there.
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

/** The shell slot registry: overlay and settings surfaces. */
export interface SlotsService {
  register(descriptor: SlotRegistration, component: unknown): () => void
  inject(slotName: string, register: () => unknown): void
}

/** Root-scope session service: live agent state. */
export interface SessionsService {
  currentProvideInfo?: Observable<SessionMaybeProvideInfo | null>
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
