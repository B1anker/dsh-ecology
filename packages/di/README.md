# @seaveyon/dsh-di

A small VS Code-style dependency injection container for DSH plugins — and for
anything else that composes a graph of services and wants it wired in one place.

> This project is independent software and is not affiliated with or endorsed by
> DeepSeek AI.

[简体中文](./README.zh-CN.md)

A DSH plugin's `apply(ctx)` receives a handful of host services and builds a
graph of its own on top of them: stores, sessions, launchers, route tables. Left
alone that graph gets wired by hand, and the wiring drifts into the code that
uses it — a store that knows how to find the file service, a route that knows
which concrete class the session manager is. This package is the alternative:
each service names what it needs by *identifier*, the composition root registers
what fills each identifier, and the container constructs the graph on demand,
once, and tears it down in reverse.

The design follows VS Code's `instantiationService` (identifiers that are both
the type and the key, `SyncDescriptor`, lazy singletons, child scopes), reduced
to what a plugin needs and with no dependencies of its own.

## Install

```sh
npm install @seaveyon/dsh-di
```

Node 20.11 or later. ESM only.

## Usage

Declare a service as an interface plus an identifier of the same name:

```ts
import { createDecorator } from '@seaveyon/dsh-di'

export interface ILogService {
  readonly _serviceBrand: undefined
  info(message: string): void
}
export const ILogService = createDecorator<ILogService>('logService')
```

`ILogService` is the type in a type position and the key in a value position.
The `_serviceBrand` member keeps two structurally similar services from being
assignable to each other by accident; declare it and never assign it.

Implement it, and declare what the implementation needs at the class level:

```ts
import { inject } from '@seaveyon/dsh-di'

@inject(ILogService, IFileService)
export class Store implements IStore {
  declare readonly _serviceBrand: undefined
  constructor(
    private readonly log: ILogService,
    private readonly files: IFileService,
    private readonly path: string,
  ) {}
}
```

Injected services occupy the leading constructor positions, in the order
declared; whatever follows is filled from *static arguments* — values only the
composition root knows, such as a path. `@inject` is a standard class decorator
(TS 5, no `experimentalDecorators` needed), and it is also a plain function:
`inject(ILogService, IFileService)(Store)` declares the same thing without
decorator syntax, for toolchains that emit none.

Wire the graph in one place:

```ts
import { InstantiationService, ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'

export function apply(ctx: PluginContext) {
  const collection = new ServiceCollection()
  // Host services are ready instances: set as-is, never disposed by the plugin.
  collection.set(IWebServer, ctx.get('webServer'))
  // The plugin's own services are recipes, built on first use, once.
  collection.set(ILogService, new SyncDescriptor(ConsoleLog))
  collection.set(IFileService, new SyncDescriptor(FileService))
  collection.set(IStore, new SyncDescriptor(Store, [join(ctx.home, 'store.json')]))
  // Registered on every boot, used by few requests: built when first touched.
  collection.set(IExporter, new SyncDescriptor(Exporter, [], true))

  const services = new InstantiationService(collection)
  ctx.effect(() => {
    services.get(IRoutes).register()
    return () => services.dispose()
  })
}
```

`services.get(IStore)` constructs `Store` with a `ConsoleLog`, a `FileService`
and the path, caches it, and hands the same instance back every time after.
`services.dispose()` calls `dispose()` on every service the container built that
has one, in reverse construction order.

## API

| Export | What it is |
| --- | --- |
| `createDecorator<T>(name)` | The identifier for a service. One object per name, process-wide, so two modules — or two copies of this package — asking for `'logService'` get the same key. Prints as its name in error messages. Also usable as a legacy parameter decorator under `experimentalDecorators`. |
| `inject(...ids)` | Class-level declaration of constructor-injected services, in parameter order. Standard class decorator or plain call. Replaces any earlier declaration on the class; a subclass declares for itself. |
| `optional(id)` | Wraps an identifier inside `inject(...)` so the position is `undefined` when nothing is registered, instead of an error. For host services that exist on some profiles and not others. |
| `SyncDescriptor(ctor, staticArguments?, supportsDelayedInstantiation?)` | A recipe: the class, the arguments for its non-injected parameters, and whether to defer construction to first use. |
| `FactoryDescriptor((accessor) => T, supportsDelayedInstantiation?)` | A recipe for code that builds its services through closure factories rather than classes. Called once with a `{ get, has }` accessor; what it pulls is recorded in the same chain as a constructor's dependencies, so cycles and missing services are reported with the factory in the path, and the result is disposed with the container. |
| `ServiceCollection` | Identifier → instance-or-recipe. `set` returns what it replaced; `has`, `get`, `delete`, `size`, `keys`, `forEach`; `clone()` for a test to override a few entries without touching the original. Plain data — it never resolves anything. |
| `InstantiationService(collection?, parent?)` | The container. Registers itself under `IInstantiationService`. |
| `services.get(id)` | The singleton, constructed on first use. Throws when unregistered (naming the chain that needed it), on a cycle (naming the path), and after `dispose()`. |
| `services.has(id)` | Registered here or in an ancestor; never constructs. |
| `services.createInstance(ctor, ...args)` / `createInstance(descriptor)` | Builds a class the container does not own — injected services from the container, the rest from `args`. Not cached, not disposed with the container. |
| `services.invokeFunction((accessor, ...args) => …, ...args)` | Runs a function with a read-only `{ get, has }` accessor, so a call site can pull two services without taking the container as a parameter. |
| `services.createChild(collection)` | A scope: resolves its own collection first, falls back to the parent. Its singletons are its own and disposed with it; parent-owned services never see child overrides. For per-request or per-job graphs. |
| `services.dispose()` | Disposes what this container built (reverse order), then its children. Ready instances set into the collection belong to whoever made them and are left alone. Idempotent; every entry point but `has` throws afterwards. |
| `IDisposable`, `isDisposable(value)`, `toDisposable(fn)` | The one lifecycle convention: a `dispose(): void` method. |
| `getServiceDependencies(ctor)`, `DI_TARGET`, `DI_DEPENDENCIES` | The declaration as stored on the constructor, for tooling. |

### DSH host services: `@seaveyon/dsh-di/host`

The host's services arrive on the plugin context by name. The `host` entry
gives the names identifiers — `IWebServer`, `IConnection`, `ITools`, plus
`IPluginContext` for the context itself — and one call that copies them into a
collection as ready instances:

```ts
import { IConnection, ITools, IWebServer, registerHostServices } from '@seaveyon/dsh-di/host'

const collection = registerHostServices(new ServiceCollection(), ctx, {
  required: [IWebServer, ITools],   // missing → apply() throws, naming the service
  optional: [IConnection],          // missing → skipped, so optional(IConnection) is undefined
})
```

The identifier names *are* the Cordis service names, and `createDecorator`
returns one object per name. A plugin whose hand-written host type is richer
than the minimal shapes exported here — most are — declares
`createDecorator<ItsOwnWebServerType>('webServer')` and gets the same key. The
shapes in `host` are the least a plugin can rely on; the plugin's own contract
file stays where its compatibility promise lives.

### Delayed instantiation

A descriptor with `supportsDelayedInstantiation = true` resolves to a proxy that
builds the real service on first member access, once. Reads, writes, `in`,
enumeration, the prototype and therefore `instanceof` all forward; methods are
bound to the real instance. What the proxy cannot offer is identity: it is never
`===` the instance behind it, and `lazy.method === lazy.method` is `false`. Use
it for services reached through their interface, which is all of them under
this pattern. A delayed service that is never touched is never built, and so
never disposed.

### Errors

Every failure names where it happened, because a service graph fails deep:

```
Service 'fileService' is not registered (while creating routes -> store)
Cyclic service dependency: routes -> store -> routes
The service container has been disposed (while creating store)
```

A construction that throws caches nothing; the next `get` tries again.

## Testing with the container

The pattern pays off most in tests. Keep the production collection in a
function, clone it, and override the edges:

```ts
const collection = createServices(ctx).clone()
collection.set(IFileService, memoryFiles)     // a double, set as an instance
const services = new InstantiationService(collection)
services.get(IStore)                           // real Store over fake files
```

`@seaveyon/dsh-plugin-testkit` builds on this: `createMockServices()` returns a
container over the testkit's host doubles, so a plugin's services can be
resolved against a fake `webServer` and `connection` without a DSH process.

## Compatibility notes

- Standard decorators only need TypeScript 5. Under `experimentalDecorators`
  the identifiers double as parameter decorators — `constructor(@ILogService
  log: ILogService)` — and `inject` still works as a class decorator.
- Declarations are stored under `Symbol.for(...)` keys and identifiers in a
  `Symbol.for`-keyed global registry, so a plugin and a host that bundle
  separate copies of this package still see one graph.
- No dependencies, no Node built-ins in the main entry: it runs anywhere
  ES2022 does, including the browser side of a plugin if it wants a container
  there. Only `@seaveyon/dsh-di/host` names `node:http` types, because DSH
  route handlers are Node's.

## License

MIT
