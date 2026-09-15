/**
 * The container: resolves identifiers to singletons, constructs classes with
 * their declared services, and disposes what it built.
 *
 * @module @seaveyon/dsh-di/instantiation
 */

import { ServiceCollection, type ServiceEntry } from './collection.js'
import { FactoryDescriptor, SyncDescriptor } from './descriptors.js'
import {
  type Constructor,
  createDecorator,
  getServiceDependencies,
  type ServiceIdentifier,
} from './identifier.js'
import { type IDisposable, isDisposable } from './lifecycle.js'

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
export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService')

/** A constructed singleton and how to reach it for disposal. */
interface Owned {
  readonly id: ServiceIdentifier<unknown>
  readonly instance: () => unknown
}

export class InstantiationService implements IInstantiationService {
  declare readonly _serviceBrand: undefined

  /** Singletons this container built, by identifier. Never mutates `services`. */
  private readonly instances = new Map<ServiceIdentifier<unknown>, unknown>()
  /** The same singletons in construction order, for reverse disposal. */
  private readonly owned: Owned[] = []
  private readonly children = new Set<InstantiationService>()
  private disposed = false

  constructor(
    private readonly services: ServiceCollection = new ServiceCollection(),
    private readonly parent?: InstantiationService,
  ) {
    // Set into the collection rather than the instance cache on purpose: a
    // child cloning this collection must not inherit the parent container as
    // *its* IInstantiationService.
    this.services.set(IInstantiationService, this)
  }

  get<T>(id: ServiceIdentifier<T>): T {
    return this.resolve(id, [])
  }

  has(id: ServiceIdentifier<unknown>): boolean {
    return this.services.has(id) || (this.parent?.has(id) ?? false)
  }

  invokeFunction<R, A extends unknown[]>(
    fn: (accessor: ServicesAccessor, ...args: A) => R,
    ...args: A
  ): R {
    this.assertLive()
    return fn(this.accessor([]), ...args)
  }

  createInstance<T>(
    recipe: SyncDescriptor<T> | FactoryDescriptor<T> | Constructor<T>,
    ...args: unknown[]
  ): T {
    this.assertLive()
    if (recipe instanceof SyncDescriptor) {
      return this.construct(recipe.ctor, recipe.staticArguments, [])
    }
    if (recipe instanceof FactoryDescriptor) return recipe.factory(this.accessor([]))
    return this.construct(recipe, args, [])
  }

  createChild(services: ServiceCollection): IInstantiationService {
    this.assertLive()
    const child = new InstantiationService(services, this)
    this.children.add(child)
    return child
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children].toReversed()) child.dispose()
    this.children.clear()
    this.parent?.children.delete(this)
    for (const entry of this.owned.toReversed()) {
      const instance = entry.instance()
      if (isDisposable(instance)) instance.dispose()
    }
    this.owned.length = 0
    this.instances.clear()
  }

  /**
   * The heart of it. `trail` is the chain of identifiers being constructed,
   * shared across parent and child so an error deep in a graph names the whole
   * path — and so a cycle is caught wherever it closes.
   */
  private resolve<T>(id: ServiceIdentifier<T>, trail: string[]): T {
    this.assertLive(trail)
    if (this.instances.has(id)) return this.instances.get(id) as T

    const entry: ServiceEntry<T> | undefined = this.services.get(id)
    if (entry === undefined) {
      if (this.parent !== undefined) return this.parent.resolve(id, trail)
      throw new Error(`Service '${String(id)}' is not registered${suffix(trail)}`)
    }
    if (!(entry instanceof SyncDescriptor) && !(entry instanceof FactoryDescriptor)) return entry

    const name = String(id)
    if (trail.includes(name)) {
      throw new Error(`Cyclic service dependency: ${[...trail, name].join(' -> ')}`)
    }

    const build = (): T => {
      trail.push(name)
      try {
        return entry instanceof SyncDescriptor
          ? this.construct(entry.ctor, entry.staticArguments, trail)
          : entry.factory(this.accessor(trail))
      } finally {
        trail.pop()
      }
    }

    if (entry.supportsDelayedInstantiation) {
      let instance: T | undefined
      const realise = (): T => {
        if (instance === undefined) {
          // A proxy handed out before `dispose()` and first touched after it
          // must not quietly build something nobody will ever dispose.
          this.assertLive([name])
          instance = build()
          // Recorded when built, not when resolved, so disposal order follows
          // construction order: the dependencies `build` just pulled in are
          // already on the list, and this lands after them.
          this.owned.push({ id, instance: () => instance })
        }
        return instance
      }
      const proxy = lazy(realise)
      // Cached before anything is built: two resolutions share the proxy and
      // so the eventual instance.
      this.instances.set(id, proxy)
      return proxy
    }

    const instance = build()
    this.instances.set(id, instance)
    this.owned.push({ id, instance: () => instance })
    return instance
  }

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
  private construct<T>(ctor: Constructor<T>, staticArgs: readonly unknown[], trail: string[]): T {
    const dependencies = getServiceDependencies(ctor)
    const concrete = ctor as unknown as new (...args: unknown[]) => T
    if (dependencies.length === 0) return new concrete(...staticArgs)

    const byIndex = new Map(dependencies.map((item) => [item.index, item]))
    // A service may be declared at any position, so the parameter list has to
    // be as long as both the highest injected index and the arguments after it.
    const highest = Math.max(...dependencies.map((item) => item.index))
    const length = Math.max(highest + 1, byIndex.size + staticArgs.length)
    const args: unknown[] = []
    let staticIndex = 0
    for (let index = 0; index < length; index += 1) {
      const dependency = byIndex.get(index)
      if (dependency !== undefined) {
        args[index] =
          dependency.optional && !this.has(dependency.id)
            ? undefined
            : this.resolve(dependency.id, trail)
      } else if (staticIndex < staticArgs.length) {
        args[index] = staticArgs[staticIndex]
        staticIndex += 1
      }
    }
    return new concrete(...args)
  }

  /**
   * The read side over a given chain, so whatever a factory or an invoked
   * function pulls is recorded — and cycle-checked — as part of that chain.
   */
  private accessor(trail: string[]): ServicesAccessor {
    return {
      get: (id) => this.resolve(id, trail),
      has: (id) => this.has(id),
    }
  }

  private assertLive(trail: string[] = []): void {
    if (this.disposed) throw new Error(`The service container has been disposed${suffix(trail)}`)
  }
}

/** Names the chain being built, so a failure deep in a graph is traceable. */
function suffix(trail: readonly string[]): string {
  return trail.length > 0 ? ` (while creating ${trail.join(' -> ')})` : ''
}

/**
 * A stand-in that builds the real service on first use.
 *
 * Construction is deferred, not skipped, and happens at most once. The proxy is
 * a safe substitute for a service reached through its interface: property
 * reads, writes, `in`, enumeration, the prototype and so `instanceof` all
 * forward. What it does not preserve is identity — the proxy is never `===` the
 * instance behind it — and methods read off it are bound to the real instance,
 * so `lazy.method === lazy.method` is false.
 */
function lazy<T>(realise: () => T): T {
  const target = () => realise() as T & object
  return new Proxy(Object.create(null) as T & object, {
    get: (_ignored, property) => {
      const value = Reflect.get(target(), property)
      // Methods must keep the real instance as their receiver; reading one off
      // the proxy would otherwise call it with the proxy as `this`.
      return typeof value === 'function' ? value.bind(target()) : value
    },
    set: (_ignored, property, value) => Reflect.set(target(), property, value),
    has: (_ignored, property) => Reflect.has(target(), property),
    deleteProperty: (_ignored, property) => Reflect.deleteProperty(target(), property),
    ownKeys: () => Reflect.ownKeys(target()),
    getPrototypeOf: () => Reflect.getPrototypeOf(target()),
    getOwnPropertyDescriptor: (_ignored, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target(), property)
      // A proxy may only report a non-configurable property if its own target
      // has one; the empty target has none, so report everything configurable.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  }) as T
}
