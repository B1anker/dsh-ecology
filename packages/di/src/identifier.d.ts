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
declare const OPTIONAL: unique symbol
/**
 * Marks a dependency the container may leave `undefined`. Produced by
 * {@link optional} and consumed by {@link inject}.
 */
export interface OptionalDependency<T> {
  readonly [OPTIONAL]: true
  readonly id: ServiceIdentifier<T>
}
/** Property under which a constructor carries the class its declarations belong to. */
export declare const DI_TARGET: unique symbol
/** Property under which a constructor carries its {@link ServiceDependency} list. */
export declare const DI_DEPENDENCIES: unique symbol
/**
 * Anything constructible. Parameters are erased on purpose: the container fills
 * them from declarations and static arguments, so no useful check is possible
 * at this type — the class's own constructor signature is where it is checked.
 */
export type Constructor<T = unknown> = abstract new (...args: any[]) => T
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
export declare function createDecorator<T>(serviceId: string): ServiceIdentifier<T>
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
export declare function optional<T>(id: ServiceIdentifier<T>): OptionalDependency<T>
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
export declare function inject(
  ...ids: InjectArgument[]
): (target: Function, context?: unknown) => void
/**
 * The dependencies a constructor declared, ordered by parameter index.
 *
 * Declarations are read only from the class itself: `DI_TARGET` records which
 * class the list was written for, so a subclass that declared nothing reports
 * nothing rather than inheriting a list that may not match its constructor.
 */
export declare function getServiceDependencies(ctor: Function): readonly ServiceDependency[]
export {}
