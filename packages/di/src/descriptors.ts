/**
 * How a service is built when it is registered as a recipe rather than as a
 * ready instance. Two recipes: a class the container constructs, or a function
 * the container calls.
 *
 * @module @seaveyon/dsh-di/descriptors
 */

import type { Constructor, ServiceIdentifier } from './identifier.js'

/**
 * A constructor plus the arguments the container cannot resolve on its own.
 *
 * `staticArguments` fill the constructor parameters that no declared service
 * claims, in order. With the class-level {@link inject} helper the services
 * occupy the leading positions, so static arguments land after them:
 *
 * ```ts
 * @inject(IFileService)
 * class Store {
 *   constructor(files: IFileService, private readonly path: string) {}
 * }
 * collection.set(IStore, new SyncDescriptor(Store, ['/tmp/store.json']))
 * ```
 *
 * `supportsDelayedInstantiation` defers construction until the first member
 * access, for services that are registered on every boot but used by few
 * requests. The container hands out a proxy in the meantime; see
 * `InstantiationService` for what the proxy does and does not preserve.
 */
export class SyncDescriptor<T> {
  constructor(
    readonly ctor: Constructor<T>,
    readonly staticArguments: readonly unknown[] = [],
    readonly supportsDelayedInstantiation = false,
  ) {}
}

/** What a {@link FactoryDescriptor}'s function receives: the container's read side. */
export interface FactoryAccessor {
  get<T>(id: ServiceIdentifier<T>): T
  has(id: ServiceIdentifier<unknown>): boolean
}

/**
 * A function the container calls once to produce the service, with an accessor
 * for whatever it needs from the graph.
 *
 * For code that already builds its collaborators through closure factories —
 * `createSessionStore(options)`, `createLaunchHandler(deps)` — and has no class
 * to hand a {@link SyncDescriptor}. The factory participates in resolution like
 * a constructor does: services it pulls through the accessor are recorded in
 * the same chain, so a cycle or a missing service is reported with the factory's
 * identifier in the path, and the result is a singleton the container disposes.
 *
 * ```ts
 * collection.set(
 *   ISessionStore,
 *   new FactoryDescriptor((accessor) =>
 *     createSessionStore({ ttlMs: 3600_000, now: accessor.get(IClock).now }),
 *   ),
 * )
 * ```
 */
export class FactoryDescriptor<T> {
  constructor(
    readonly factory: (accessor: FactoryAccessor) => T,
    readonly supportsDelayedInstantiation = false,
  ) {}
}
