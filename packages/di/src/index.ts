/**
 * `@seaveyon/dsh-di` — a small VS Code-style service container.
 *
 * ```ts
 * import { createDecorator, inject, InstantiationService, ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'
 *
 * export interface ILogService { readonly _serviceBrand: undefined; info(message: string): void }
 * export const ILogService = createDecorator<ILogService>('logService')
 *
 * @inject(ILogService)
 * class Store {
 *   constructor(private readonly log: ILogService, private readonly path: string) {}
 * }
 *
 * const collection = new ServiceCollection()
 * collection.set(ILogService, new SyncDescriptor(ConsoleLog))
 * collection.set(IStore, new SyncDescriptor(Store, ['/tmp/store.json']))
 * const services = new InstantiationService(collection)
 * services.get(IStore) // built once, with ConsoleLog injected
 * services.dispose()   // disposes what it built, in reverse order
 * ```
 *
 * @module @seaveyon/dsh-di
 */

export { ServiceCollection, type ServiceEntry } from './collection.js'
export { type FactoryAccessor, FactoryDescriptor, SyncDescriptor } from './descriptors.js'
export {
  type Constructor,
  createDecorator,
  DI_DEPENDENCIES,
  DI_TARGET,
  getServiceDependencies,
  type InjectArgument,
  inject,
  type OptionalDependency,
  optional,
  type ServiceDependency,
  type ServiceIdentifier,
} from './identifier.js'
export {
  IInstantiationService,
  InstantiationService,
  type ServicesAccessor,
} from './instantiation.js'
export { type IDisposable, isDisposable, toDisposable } from './lifecycle.js'
