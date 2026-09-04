/**
 * Discovery of desktop pets: a tiny observable roster plus connection status.
 *
 * The desktop app serves the full pet roster — built-ins included — over its
 * loopback server (see `fetchDesktopPets` in bridge.ts). This store holds the
 * last fetch's outcome and exposes it in the shell's observable shape
 * (`getSnapshot`/`subscribe`), so the settings panel subscribes with
 * `useSyncExternalStore` exactly like it does for settings.
 *
 * The status half of the snapshot matters as much as the roster: the panel is
 * single-source — when the desktop app answers, its roster is the whole
 * picker; before that (`unknown`, or a proven-unreachable `offline`) the
 * picker renders nothing, because a page-side stand-in roster would promise
 * a choice the desktop cannot honor.
 *
 * Discovery is pull-based: the panel fetches on mount (with a couple of
 * quiet retries after a failure) and re-checks on a slow poll while open, so
 * a desktop app that was quit stops being "connected". A failed refresh
 * keeps the previous roster — a desktop app that just quit must not make an
 * already-listed pet vanish mid-render.
 *
 * @module @seaveyon/dsh-pet/client/desktop-pets
 */

import { type DesktopPet, type FetchDesktopPetsOptions, fetchDesktopPets } from './bridge.js'

/** Whether the desktop app's roster has answered, failed, or never been asked. */
export type DesktopPetsStatus = 'unknown' | 'online' | 'offline'

export interface DesktopPetsSnapshot {
  pets: readonly DesktopPet[]
  status: DesktopPetsStatus
}

export interface DesktopPetsStoreOptions extends FetchDesktopPetsOptions {}

export class DesktopPetsStore {
  private readonly options: FetchDesktopPetsOptions
  private readonly listeners = new Set<() => void>()
  private snapshot: DesktopPetsSnapshot = { pets: [], status: 'unknown' }
  private refreshing: Promise<void> | null = null

  constructor(options: DesktopPetsStoreOptions = {}) {
    this.options = options
  }

  /** The last settled discovery outcome. Cached identity, as React requires. */
  getSnapshot = (): DesktopPetsSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Look up a pet by id in the last successfully fetched roster. */
  find(id: string): DesktopPet | undefined {
    return this.snapshot.pets.find((pet) => pet.id === id)
  }

  /**
   * Ask the desktop app for its pets. Concurrent calls share one in-flight
   * request; failures resolve quietly with the roster unchanged (only the
   * status moves to `offline`). Returned so tests can await the settle;
   * callers fire-and-forget it.
   */
  refresh(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing
    this.refreshing = this.runRefresh()
    return this.refreshing
  }

  private async runRefresh(): Promise<void> {
    // fetchDesktopPets resolves null on every failure, so this never rejects.
    const pets = await fetchDesktopPets(this.options)
    this.refreshing = null
    if (pets === null) {
      this.setSnapshot({ pets: this.snapshot.pets, status: 'offline' })
      return
    }
    this.setSnapshot({ pets, status: 'online' })
  }

  private setSnapshot(next: DesktopPetsSnapshot): void {
    // Same roster and same status arriving again is not a change; spare
    // subscribers a render.
    if (
      next.status === this.snapshot.status &&
      JSON.stringify(next.pets) === JSON.stringify(this.snapshot.pets)
    ) {
      return
    }
    this.snapshot = next
    for (const listener of Array.from(this.listeners)) listener()
  }
}

/**
 * Humanize an imported pet id for the picker: `ai-sleepy-silver-wolf` reads
 * better as "Ai Sleepy Silver Wolf". Ids arrive from the desktop app with no
 * locale, so there is nothing to translate — just typography.
 */
export function prettifyImportedPetId(id: string): string {
  const words = id
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
  return words.length > 0 ? words.join(' ') : id
}
