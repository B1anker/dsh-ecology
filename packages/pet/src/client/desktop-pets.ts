/**
 * Discovery of imported desktop pets: a tiny observable roster.
 *
 * The desktop app can serve imported bitmap pets (see `fetchDesktopPets` in
 * bridge.ts) that the built-in SVG roster knows nothing about. This store
 * holds the last successfully fetched list and exposes it in the shell's
 * observable shape (`getSnapshot`/`subscribe`), so the overlay and the
 * settings panel subscribe with `useSyncExternalStore` exactly like they do
 * for settings and mood.
 *
 * Discovery is pull-based and lazy: nothing fetches until a mounted surface
 * calls {@link DesktopPetsStore.refresh} (the overlay on mount, the panel each
 * time it opens). A failed refresh keeps the previous list — a desktop app
 * that just quit must not make an already-displayed imported pet vanish
 * mid-render; the overlay's blob fallback owns that case.
 *
 * @module @seaveyon/dsh-pet/client/desktop-pets
 */

import { type DesktopPet, type FetchDesktopPetsOptions, fetchDesktopPets } from './bridge.js'

export interface DesktopPetsStoreOptions extends FetchDesktopPetsOptions {}

export class DesktopPetsStore {
  private readonly options: FetchDesktopPetsOptions
  private readonly listeners = new Set<() => void>()
  private pets: readonly DesktopPet[] = []
  private refreshing: Promise<void> | null = null

  constructor(options: DesktopPetsStoreOptions = {}) {
    this.options = options
  }

  /** The last successfully fetched roster. Cached identity, as React requires. */
  getSnapshot = (): readonly DesktopPet[] => this.pets

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Look up an imported pet by id. */
  find(id: string): DesktopPet | undefined {
    return this.pets.find((pet) => pet.id === id)
  }

  /**
   * Ask the desktop app for its imported pets. Concurrent calls share one
   * in-flight request; failures resolve quietly with the roster unchanged.
   * Returned so tests can await the settle; callers fire-and-forget it.
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
    if (pets === null) return
    // Same roster arriving again is not a change; spare subscribers a render.
    if (JSON.stringify(pets) === JSON.stringify(this.pets)) return
    this.pets = pets
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
