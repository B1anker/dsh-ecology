/**
 * The registry a container resolves from.
 *
 * @module @seaveyon/dsh-di/collection
 */

import type { FactoryDescriptor, SyncDescriptor } from './descriptors.js'
import type { ServiceIdentifier } from './identifier.js'

/** What a collection holds under an identifier: a ready instance or a recipe. */
export type ServiceEntry<T> = T | SyncDescriptor<T> | FactoryDescriptor<T>

/**
 * Identifier → entry. An entry is either a ready instance or a recipe — a
 * {@link SyncDescriptor} the container constructs or a {@link FactoryDescriptor}
 * it calls — on first use, after which the container serves the resulting
 * singleton from its own cache.
 *
 * The collection is plain data: it does no resolution and holds no state
 * beyond the map, so a composition root can build one, hand it to a container,
 * and a test can `clone()` it and override a few entries with doubles.
 */
export class ServiceCollection {
  private readonly entries = new Map<ServiceIdentifier<unknown>, unknown>()

  constructor(...entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>) {
    for (const [id, entry] of entries) this.entries.set(id, entry)
  }

  /** Registers an entry, returning whatever it replaced. */
  set<T>(id: ServiceIdentifier<T>, entry: ServiceEntry<T>): ServiceEntry<T> | undefined {
    const previous = this.entries.get(id) as ServiceEntry<T> | undefined
    this.entries.set(id, entry)
    return previous
  }

  has(id: ServiceIdentifier<unknown>): boolean {
    return this.entries.has(id)
  }

  get<T>(id: ServiceIdentifier<T>): ServiceEntry<T> | undefined {
    return this.entries.get(id) as ServiceEntry<T> | undefined
  }

  /** Removes an entry; true when there was one. */
  delete(id: ServiceIdentifier<unknown>): boolean {
    return this.entries.delete(id)
  }

  /** Number of registered identifiers. */
  get size(): number {
    return this.entries.size
  }

  /** Every registered identifier, in registration order. */
  keys(): IterableIterator<ServiceIdentifier<unknown>> {
    return this.entries.keys()
  }

  /** Every registered entry, for diagnostics that report on the container. */
  forEach(callback: (id: ServiceIdentifier<unknown>, entry: unknown) => void): void {
    for (const [id, entry] of this.entries) callback(id, entry)
  }

  /**
   * A shallow copy: the same identifiers and the same entries (descriptors are
   * shared, not re-created), in a new map. The intended use is a test taking a
   * production collection and swapping a few services for doubles without
   * touching the original.
   */
  clone(): ServiceCollection {
    return new ServiceCollection(...this.entries)
  }
}
