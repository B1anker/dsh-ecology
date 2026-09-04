/**
 * Pet configuration persistence: one small record, two backends.
 *
 * The preferred backend is the shell's `settingsScope` binder, whose `set` is
 * per-field. But the settings RPC is loopback-only — a browser pointed at a
 * remote DSH host gets a memory-only scope that forgets everything on reload
 * (contract note in host-types.ts). So every write *also* lands in
 * localStorage under `dsh-pet:config`, and reads prefer a ready scope
 * snapshot, then localStorage, then defaults. The result: loopback users get
 * real settings sync, remote users still keep their pet across reloads.
 *
 * Both backends are optional at runtime: a scope whose `bind` throws and a
 * storage that throws (private mode, disabled cookies) are both tolerated —
 * the store degrades to in-memory defaults instead of breaking the plugin.
 *
 * @module @seaveyon/dsh-pet/client/settings
 */

import type { BoundSettingsScope, SettingsScopeBinder } from './host-types.js'

export interface PetConfig {
  name: string
  petId: string
  /**
   * Push state to the desktop companion app (see bridge.ts). On by default:
   * driving the desktop pet is the plugin's whole job, and a desktop app that
   * isn't running makes the bridge fail silently, not noisily.
   */
  companionEnabled: boolean
}

export const DEFAULT_CONFIG: PetConfig = {
  name: 'Mochi',
  petId: 'blob',
  companionEnabled: true,
}

export const CONFIG_STORAGE_KEY = 'dsh-pet:config'

const MAX_NAME_LENGTH = 40

/**
 * Whatever partial junk a backend might hand back, narrowed field by field.
 * Fields from older versions (`visible`, `scale` — page-overlay concepts the
 * desktop pivot removed) are simply not copied, so a stale stored record
 * parses cleanly instead of breaking the store.
 */
function sanitize(raw: unknown): Partial<PetConfig> {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const out: Partial<PetConfig> = {}
  if (typeof record['name'] === 'string') out.name = record['name'].slice(0, MAX_NAME_LENGTH)
  if (typeof record['petId'] === 'string') out.petId = record['petId']
  if (typeof record['companionEnabled'] === 'boolean')
    out.companionEnabled = record['companionEnabled']
  return out
}

export interface PetSettingsStoreOptions {
  binder?: SettingsScopeBinder
  /** Defaults to globalThis.localStorage when present. */
  storage?: Storage
}

/**
 * The config store: an observable snapshot of PetConfig plus `update`.
 *
 * Observable-shaped (`getSnapshot`/`subscribe`, cached snapshot identity) so
 * both React surfaces subscribe with `useSyncExternalStore` unchanged.
 */
export class PetSettingsStore {
  private readonly scope: BoundSettingsScope | null = null
  private readonly storage: Storage | null
  private readonly listeners = new Set<() => void>()
  private config: PetConfig

  constructor(options: PetSettingsStoreOptions = {}) {
    this.storage = options.storage ?? safeLocalStorage()
    if (options.binder !== undefined) {
      try {
        this.scope = options.binder.bind({ namespace: 'dsh-pet' })
      } catch {
        // A binder that fails at bind time is treated as absent — the
        // localStorage path below is exactly as functional for a solo client.
        this.scope = null
      }
    }

    this.config = this.read()

    // External changes to the scope (another tab, the shell's own settings
    // UI) flow back in. Memory-only scopes never fire this, so remote
    // browsers are unaffected.
    this.scope?.subscribe(() => {
      const next = this.read()
      if (JSON.stringify(next) === JSON.stringify(this.config)) return
      this.config = next
      this.notify()
    })
  }

  getSnapshot = (): PetConfig => this.config

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Merge a patch, persist it to both backends, and notify. Scope writes are
   * fire-and-forget: their promises are caught so a broken RPC can never
   * surface as an unhandled rejection in the shell page.
   */
  update(patch: Partial<PetConfig>): void {
    this.config = { ...this.config, ...sanitize({ ...this.config, ...patch }) }
    for (const [field, value] of Object.entries(patch)) {
      this.scope?.set(field, value).catch(() => {})
    }
    this.writeLocal()
    this.notify()
  }

  /** Read precedence: ready scope snapshot > localStorage > defaults. */
  private read(): PetConfig {
    let config = { ...DEFAULT_CONFIG, ...sanitize(this.readLocal()) }
    try {
      const snapshot = this.scope?.getSnapshot()
      if (snapshot?.status === 'ready' && snapshot.value !== undefined) {
        config = { ...config, ...sanitize(snapshot.value) }
      }
    } catch {
      // A scope that throws on read is worse than none; keep the local value.
    }
    return config
  }

  private readLocal(): unknown {
    if (this.storage === null) return undefined
    try {
      const raw = this.storage.getItem(CONFIG_STORAGE_KEY)
      return raw === null ? undefined : (JSON.parse(raw) as unknown)
    } catch {
      return undefined
    }
  }

  private writeLocal(): void {
    if (this.storage === null) return
    try {
      this.storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config))
    } catch {
      // Quota or privacy-mode rejection: the scope write already happened, so
      // the cost is only "this browser forgets on reload".
    }
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
