/**
 * How a service is built when it is registered as a class rather than as a
 * ready instance.
 *
 * @module @seaveyon/dsh-di/descriptors
 */

import type { Constructor } from './identifier.js'

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
