/**
 * The container: resolves identifiers to singletons, constructs classes with
 * their declared services, and disposes what it built.
 *
 * @module @seaveyon/dsh-di/instantiation
 */
import { ServiceCollection } from './collection.js'
import { FactoryDescriptor, SyncDescriptor } from './descriptors.js'
import { type Constructor, type ServiceIdentifier } from './identifier.js'
import { type IDisposable } from './lifecycle.js'
/**
 * What `invokeFunction` hands its callback: the container's read side, without
 * the ability to build or dispose. A call site that needs two services pulls
 * them here instead of threading the container through its signature.
 */
export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T
  has(id: ServiceIdentifier<unknown>): boolean
}
export interface IInstantiationService extends IDisposable {
  readonly _serviceBrand: undefined
  /**
   * The singleton registered under `id`, constructing it on first use. Throws
   * when nothing is registered under `id` in this container or an ancestor,
   * naming the chain that needed it, and after `dispose()`.
   */
  get<T>(id: ServiceIdentifier<T>): T
  /** Whether `id` is registered here or in an ancestor; never constructs anything. */
  has(id: ServiceIdentifier<unknown>): boolean
  /**
   * Runs `fn` with an accessor, so a call site can pull the few services it
   * needs without threading the container itself through its signature.
   */
  invokeFunction<R, A extends unknown[]>(
    fn: (accessor: ServicesAccessor, ...args: A) => R,
    ...args: A
  ): R
  /**
   * Builds a class the container does not own, injecting its declared services
   * and filling the remaining parameters from `args` — or runs a factory with
   * an accessor. The result is the caller's: it is not cached and not disposed
   * with the container.
   */
  createInstance<T>(descriptor: SyncDescriptor<T> | FactoryDescriptor<T>): T
  createInstance<C extends Constructor>(ctor: C, ...args: unknown[]): InstanceType<C>
  /**
   * A container that resolves `services` first and falls back to this one.
   * Its singletons are its own — disposed with the child — while anything it
   * reaches through the parent stays the parent's. Per-request or per-job
   * scopes are the intended use.
   */
  createChild(services: ServiceCollection): IInstantiationService
  /**
   * Disposes every service this container constructed that has a `dispose()`
   * method, in reverse construction order, then its children. Instances set
   * into the collection ready-made belong to whoever made them and are left
   * alone. Idempotent; the container refuses to resolve afterwards.
   */
  dispose(): void
}
/** The container registers itself under this, so a service can build collaborators. */
export declare const IInstantiationService: ServiceIdentifier<IInstantiationService>
export declare class InstantiationService implements IInstantiationService {
  private readonly services
  private readonly parent?
  readonly _serviceBrand: undefined
  /** Singletons this container built, by identifier. Never mutates `services`. */
  private readonly instances
  /** The same singletons in construction order, for reverse disposal. */
  private readonly owned
  private readonly children
  private disposed
  constructor(services?: ServiceCollection, parent?: InstantiationService | undefined)
  get<T>(id: ServiceIdentifier<T>): T
  has(id: ServiceIdentifier<unknown>): boolean
  invokeFunction<R, A extends unknown[]>(
    fn: (accessor: ServicesAccessor, ...args: A) => R,
    ...args: A
  ): R
  createInstance<T>(
    recipe: SyncDescriptor<T> | FactoryDescriptor<T> | Constructor<T>,
    ...args: unknown[]
  ): T
  createChild(services: ServiceCollection): IInstantiationService
  dispose(): void
  /**
   * The heart of it. `trail` is the chain of identifiers being constructed,
   * shared across parent and child so an error deep in a graph names the whole
   * path — and so a cycle is caught wherever it closes.
   */
  private resolve
  /**
   * Fills every constructor parameter: the positions a declaration claims are
   * resolved from the container (or left `undefined` when optional and
   * unregistered), and the rest consume `staticArgs` in order.
   *
   * Surplus static arguments are passed through rather than refused —
   * `ctor.length` does not count default or rest parameters, so there is no
   * reliable arity to check against, and ignoring a trailing argument is what
   * `new ctor(...)` does.
   */
  private construct
  /**
   * The read side over a given chain, so whatever a factory or an invoked
   * function pulls is recorded — and cycle-checked — as part of that chain.
   */
  private accessor
  private assertLive
}
