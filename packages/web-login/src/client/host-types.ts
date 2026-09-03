/**
 * Hand-written types for the DSH shell client services this plugin binds to.
 *
 * Same trade-off as `src/types.ts` on the host side: the shell packages are not
 * on the public registry, so these declarations track the observed runtime
 * contract (verified against DSH 0.1.1-rc.2 alongside `@seaveyon/dsh-pet`).
 *
 * @module @seaveyon/dsh-web-login/client/host-types
 */

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

/** Translate function returned by `locale.bind(ns)`. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Immutable locale snapshot published by the shell locale service. */
export interface LocaleSnapshot {
  active: 'zh' | 'en' | string
  revision: number
}

/** Shell locale registry used for dictionaries and language switching. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): Translate
  getSnapshot(): LocaleSnapshot
  subscribe(listener: () => void): () => void
}

/** The plugin context handed to `apply`, structurally. */
export interface ClientContext {
  get(name: 'slots'): SlotsService | undefined
  get(name: 'locale'): LocaleService | undefined
  get(name: string): unknown
  /** Cordis also exposes provided services as context properties. */
  locale?: LocaleService
  effect?(fn: () => (() => void) | void, label?: string): void
}
