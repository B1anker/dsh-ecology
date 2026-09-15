/**
 * Service identifiers and the dependency declarations the container reads.
 *
 * An identifier is created once per service name and doubles as three things:
 * the key a {@link ServiceCollection} is indexed by, the carrier of the service
 * *type* (through the phantom `type` member, which never exists at runtime), and
 * — for codebases compiled with `experimentalDecorators` — a parameter decorator
 * (`constructor(@IFileService files: IFileService)`). Codebases on standard
 * decorators, which have no parameter decorators, declare the same thing at the
 * class level with {@link inject}; Bun, tsc and SWC all emit that form.
 *
 * Declarations are stored on the constructor under two well-known symbols. They
 * are `Symbol.for` rather than local symbols so two copies of this package in
 * one process (a plugin and its host bundling different versions) still read
 * each other's declarations.
 *
 * @module @seaveyon/dsh-di/identifier
 */

/**
 * The handle a service is registered and resolved by.
 *
 * `T` is phantom: `type` is declared and never assigned, so `IFoo` can be used
 * both as a value (the key) and, through `typeof IFoo` inference, as the type
 * the container hands back for it.
 */
export interface ServiceIdentifier<T> {
  /**
   * Legacy parameter-decorator form (`experimentalDecorators`). Called by the
   * compiler as `(target, propertyKey, parameterIndex)` for constructor
   * parameters; any other use throws so a misplaced decorator is a loud error
   * rather than a silently unresolved dependency.
   */
  (target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void
  /** Phantom carrier of the service type. Never present at runtime. */
  readonly type: T
  toString(): string
}

/**
 * A dependency as the container sees it: which identifier fills which
 * constructor position, and whether the position may be left `undefined` when
 * nothing is registered under it.
 */
export interface ServiceDependency {
  readonly id: ServiceIdentifier<unknown>
  readonly index: number
  readonly optional: boolean
}

const OPTIONAL: unique symbol = Symbol.for('@seaveyon/dsh-di:optional')

/**
 * Marks a dependency the container may leave `undefined`. Produced by
 * {@link optional} and consumed by {@link inject}.
 */
export interface OptionalDependency<T> {
  readonly [OPTIONAL]: true
  readonly id: ServiceIdentifier<T>
}

/** Property under which a constructor carries the class its declarations belong to. */
export const DI_TARGET: unique symbol = Symbol.for('@seaveyon/dsh-di:target')
/** Property under which a constructor carries its {@link ServiceDependency} list. */
export const DI_DEPENDENCIES: unique symbol = Symbol.for('@seaveyon/dsh-di:dependencies')

/**
 * Anything constructible. Parameters are erased on purpose: the container fills
 * them from declarations and static arguments, so no useful check is possible
 * at this type — the class's own constructor signature is where it is checked.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type Constructor<T = unknown> = abstract new (...args: any[]) => T

interface DeclaringConstructor {
  [DI_TARGET]?: Function
  [DI_DEPENDENCIES]?: ServiceDependency[]
}

/**
 * One identifier per name, process-wide. Two `createDecorator('log')` calls —
 * in two modules, or in two copies of a consumer — yield the same object, so a
 * service registered by one is found by the other. The registry is global for
 * the same reason the symbols above are.
 */
const registry: Map<string, ServiceIdentifier<unknown>> = (() => {
  const key = Symbol.for('@seaveyon/dsh-di:registry')
  const host = globalThis as typeof globalThis & { [key]?: Map<string, ServiceIdentifier<unknown>> }
  host[key] ??= new Map()
  return host[key]
})()

/**
 * Create (or look up) the identifier for a service.
 *
 * ```ts
 * export interface ILogService {
 *   readonly _serviceBrand: undefined
 *   info(message: string): void
 * }
 * export const ILogService = createDecorator<ILogService>('logService')
 * ```
 *
 * The interface and the constant share a name on purpose: `ILogService` is the
 * type in a type position and the key in a value position.
 *
 * @param serviceId - the name, used in error messages and as the registry key.
 */
export function createDecorator<T>(serviceId: string): ServiceIdentifier<T> {
  const existing = registry.get(serviceId)
  if (existing !== undefined) return existing as ServiceIdentifier<T>

  const id = function decorate(
    target: object,
    _propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ): void {
    if (
      arguments.length !== 3 ||
      typeof target !== 'function' ||
      typeof parameterIndex !== 'number'
    ) {
      throw new Error(`@${serviceId} can only decorate a constructor parameter`)
    }
    appendDependency(target, {
      id: id as ServiceIdentifier<unknown>,
      index: parameterIndex,
      optional: false,
    })
  } as unknown as ServiceIdentifier<T>

  Object.defineProperty(id, 'toString', { value: () => serviceId })
  registry.set(serviceId, id as ServiceIdentifier<unknown>)
  return id
}

/**
 * Wrap an identifier so the position it fills may stay `undefined` when the
 * service is not registered.
 *
 * ```ts
 * @inject(IWebServer, optional(IConnection))
 * class Routes {
 *   constructor(web: IWebServer, connection: IConnection | undefined) {}
 * }
 * ```
 *
 * A DSH plugin meets this shape often: a host service that exists on some
 * profiles and not others (the login gate, the browser-authentication fence).
 */
export function optional<T>(id: ServiceIdentifier<T>): OptionalDependency<T> {
  return { [OPTIONAL]: true, id }
}

function isOptional(value: unknown): value is OptionalDependency<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as OptionalDependency<unknown>)[OPTIONAL] === true
  )
}

/** A single `inject(...)` argument: a plain identifier or an {@link optional} one. */
export type InjectArgument = ServiceIdentifier<unknown> | OptionalDependency<unknown>

/**
 * Declare a class's constructor-injected services, in parameter order.
 *
 * Works as a standard class decorator and as a plain function, so it needs no
 * particular compiler setting:
 *
 * ```ts
 * @inject(IFileService, IProfileService)
 * class DriftService {
 *   constructor(files: IFileService, profiles: IProfileService, readonly path: string) {}
 * }
 * // …or, without decorator syntax:
 * inject(IFileService, IProfileService)(DriftService)
 * ```
 *
 * The services occupy the leading constructor positions; whatever follows is
 * filled from the static arguments a {@link SyncDescriptor} or `createInstance`
 * call supplies. Calling `inject` on a class replaces any earlier declaration
 * on it, including one inherited from a parent class: a subclass with a
 * different constructor must declare its own list.
 */
export function inject(...ids: InjectArgument[]): (target: Function, context?: unknown) => void {
  const dependencies = ids.map(
    (entry, index): ServiceDependency =>
      isOptional(entry)
        ? { id: entry.id, index, optional: true }
        : { id: entry, index, optional: false },
  )
  return (target) => {
    if (typeof target !== 'function') {
      throw new Error('inject(...) can only be applied to a class')
    }
    const ctor = target as Function & DeclaringConstructor
    ctor[DI_DEPENDENCIES] = [...dependencies]
    ctor[DI_TARGET] = target
  }
}

function appendDependency(target: Function, dependency: ServiceDependency): void {
  const ctor = target as Function & DeclaringConstructor
  if (ctor[DI_TARGET] === target && ctor[DI_DEPENDENCIES] !== undefined) {
    ctor[DI_DEPENDENCIES].push(dependency)
    return
  }
  ctor[DI_DEPENDENCIES] = [dependency]
  ctor[DI_TARGET] = target
}

/**
 * The dependencies a constructor declared, ordered by parameter index.
 *
 * Declarations are read only from the class itself: `DI_TARGET` records which
 * class the list was written for, so a subclass that declared nothing reports
 * nothing rather than inheriting a list that may not match its constructor.
 */
export function getServiceDependencies(ctor: Function): readonly ServiceDependency[] {
  const target = ctor as Function & DeclaringConstructor
  if (target[DI_TARGET] !== ctor || target[DI_DEPENDENCIES] === undefined) return []
  return target[DI_DEPENDENCIES].toSorted((a, b) => a.index - b.index)
}
