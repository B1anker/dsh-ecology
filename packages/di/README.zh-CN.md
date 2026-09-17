# @seaveyon/dsh-di

一个面向 DSH 插件的小型依赖注入容器，风格沿袭 VS Code 的
`instantiationService`——也适用于任何想把一张服务图集中在一处装配的代码。

> 本项目为独立软件，与 DeepSeek AI 无关联，亦未获其背书。

[English](./README.md)

DSH 插件的 `apply(ctx)` 拿到几项宿主服务，然后在其上搭起自己的一张图：存储、会话、
启动器、路由表。放任不管的话，这张图就靠手工装配，而装配逻辑会渗进使用它的代码里——
存储知道怎么找到文件服务，路由知道会话管理器具体是哪个类。本包提供另一种做法：每个
服务用**标识符**声明自己需要什么，组合根登记每个标识符由谁来填，容器按需构造整张图，
只构造一次，并按逆序拆除。

设计取自 VS Code（既是类型又是键的标识符、`SyncDescriptor`、惰性单例、子作用域），
削减到插件所需的程度，且自身零依赖。

## 安装

```sh
npm install @seaveyon/dsh-di
```

Node 20.11 及以上，仅提供 ESM。

## 用法

把服务声明成同名的接口加标识符：

```ts
import { createDecorator } from '@seaveyon/dsh-di'

export interface ILogService {
  readonly _serviceBrand: undefined
  info(message: string): void
}
export const ILogService = createDecorator<ILogService>('logService')
```

在类型位置上 `ILogService` 是类型，在值位置上它是键。`_serviceBrand` 用来防止两个结构
相似的服务被意外互相赋值；只声明，永不赋值。

实现它，并在类级别声明实现需要什么：

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

被注入的服务按声明顺序占据构造函数的前几个位置；其后的参数由**静态参数**填充——
只有组合根才知道的值，比如路径。`@inject` 是标准类装饰器（TS 5，不需要
`experimentalDecorators`），同时也是普通函数：`inject(ILogService, IFileService)(Store)`
在不支持装饰器语法的工具链下声明同样的内容。

在一处装配整张图：

```ts
import { InstantiationService, ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'

export function apply(ctx: PluginContext) {
  const collection = new ServiceCollection()
  // 宿主服务是现成实例：原样放入，插件永不 dispose 它们。
  collection.set(IWebServer, ctx.get('webServer'))
  // 插件自己的服务是配方：首次使用时构造，仅一次。
  collection.set(ILogService, new SyncDescriptor(ConsoleLog))
  collection.set(IFileService, new SyncDescriptor(FileService))
  collection.set(IStore, new SyncDescriptor(Store, [join(ctx.home, 'store.json')]))
  // 每次启动都登记、但只有少数请求会用到：首次触碰时再构造。
  collection.set(IExporter, new SyncDescriptor(Exporter, [], true))

  const services = new InstantiationService(collection)
  ctx.effect(() => {
    services.get(IRoutes).register()
    return () => services.dispose()
  })
}
```

`services.get(IStore)` 用一个 `ConsoleLog`、一个 `FileService` 和路径构造 `Store`，
缓存后此后每次返回同一实例。`services.dispose()` 对容器构造过的、带 `dispose()` 的
每个服务按构造逆序调用之。

## API

| 导出 | 说明 |
| --- | --- |
| `createDecorator<T>(name)` | 服务标识符。同名在整个进程内只有一个对象，两个模块——或本包的两份副本——请求 `'logService'` 得到同一个键。报错信息中以名字呈现。`experimentalDecorators` 下还可作为参数装饰器使用。 |
| `inject(...ids)` | 类级别的构造函数注入声明，按参数顺序。既是标准类装饰器也是普通调用。覆盖该类上更早的声明；子类需自行声明。 |
| `optional(id)` | 在 `inject(...)` 中包裹标识符，使该位置在未登记时得到 `undefined` 而非报错。用于只在部分 profile 上存在的宿主服务。 |
| `SyncDescriptor(ctor, staticArguments?, supportsDelayedInstantiation?)` | 配方：类、非注入参数的取值，以及是否推迟到首次使用再构造。 |
| `FactoryDescriptor((accessor) => T, supportsDelayedInstantiation?)` | 面向用闭包工厂而非类来构建服务的代码的配方。以 `{ get, has }` 访问器调用一次；它取用的服务与构造函数依赖记在同一条链上，成环或缺失时报错路径中带有该工厂，结果随容器 dispose。 |
| `ServiceCollection` | 标识符 → 实例或配方。`set` 返回被替换的条目；`has`、`get`、`delete`、`size`、`keys`、`forEach`；`clone()` 供测试覆盖少数条目而不动原件。纯数据，从不解析。 |
| `InstantiationService(collection?, parent?)` | 容器。把自己登记在 `IInstantiationService` 下。 |
| `services.get(id)` | 单例，首次使用时构造。未登记（报出需要它的链）、成环（报出路径）、`dispose()` 之后均抛错。 |
| `services.has(id)` | 本容器或祖先中是否登记；从不构造。 |
| `services.createInstance(ctor, ...args)` / `createInstance(descriptor)` | 构造一个容器不拥有的类——注入的服务来自容器，其余来自 `args`。不缓存，不随容器 dispose。 |
| `services.invokeFunction((accessor, ...args) => …, ...args)` | 以只读的 `{ get, has }` 访问器运行一个函数，让调用点取两个服务而不必把容器当参数传。 |
| `services.createChild(collection)` | 作用域：先查自己的集合，再回退到父容器。其单例归自己、随自己 dispose；父容器拥有的服务看不到子作用域的覆盖。用于按请求或按任务的图。 |
| `services.dispose()` | 按逆序 dispose 本容器构造的服务，再 dispose 子容器。作为实例放入集合的现成对象归其创建者，不动。幂等；此后除 `has` 外所有入口抛错。 |
| `IDisposable`、`isDisposable(value)`、`toDisposable(fn)` | 唯一的生命周期约定：一个 `dispose(): void` 方法。 |
| `getServiceDependencies(ctor)`、`DI_TARGET`、`DI_DEPENDENCIES` | 存在构造函数上的声明本身，供工具读取。 |

### DSH 宿主服务：`@seaveyon/dsh-di/host`

宿主的服务按名字挂在插件上下文上。`host` 入口为这些名字提供标识符——`IWebServer`、
`IConnection`、`ITools`，以及代表上下文自身的 `IPluginContext`——并用一次调用把它们
作为现成实例复制进集合：

```ts
import { IConnection, ITools, IWebServer, registerHostServices } from '@seaveyon/dsh-di/host'

const collection = registerHostServices(new ServiceCollection(), ctx, {
  required: [IWebServer, ITools],   // 缺失 → apply() 抛错并点名该服务
  optional: [IConnection],          // 缺失 → 跳过，于是 optional(IConnection) 得到 undefined
})
```

标识符的名字**就是** Cordis 服务名，而 `createDecorator` 对同一个名字只返回一个对象。
插件手写的宿主类型若比这里导出的最小形状更丰富——大多如此——只需声明
`createDecorator<自己的WebServer类型>('webServer')`，拿到的就是同一个键。`host` 里的
形状是插件能依赖的最小集合；插件自己的契约文件仍是其兼容性承诺所在。

### 延迟构造

`supportsDelayedInstantiation = true` 的配方解析为一个代理，在首次访问成员时构造真实
服务，仅一次。读、写、`in`、枚举、原型乃至 `instanceof` 都会转发；方法绑定到真实
实例。代理无法提供的是同一性：它永不 `===` 其背后的实例，且
`lazy.method === lazy.method` 为 `false`。只用于通过接口访问的服务——在这套模式下，
所有服务都是。从未被触碰的延迟服务永不构造，也就永不 dispose。

### 报错

服务图的失败往往发生在深处，所以每条错误都指出位置：

```
Service 'fileService' is not registered (while creating routes -> store)
Cyclic service dependency: routes -> store -> routes
The service container has been disposed (while creating store)
```

抛错的构造不留缓存；下一次 `get` 重试。

## 在测试中使用容器

这套模式在测试里收益最大。把生产集合放进一个函数，克隆它，再替换边缘：

```ts
const collection = createServices(ctx).clone()
collection.set(IFileService, memoryFiles)     // 替身，作为实例放入
const services = new InstantiationService(collection)
services.get(IStore)                           // 真 Store，跑在假文件系统上
```

`@seaveyon/dsh-plugin-testkit` 在此基础上提供 `createMockServices()`：返回一个建在
testkit 宿主替身之上的容器，插件的服务可以在没有 DSH 进程的情况下对着假的
`webServer` 与 `connection` 解析。

## 兼容性说明

- 标准装饰器只需 TypeScript 5。在 `experimentalDecorators` 下，标识符可兼作参数
  装饰器——`constructor(@ILogService log: ILogService)`——`inject` 仍是类装饰器。
- 声明存放在 `Symbol.for(...)` 键下，标识符放在以 `Symbol.for` 为键的全局注册表里，
  因此分别打包了本包副本的插件与宿主仍共享同一张图。
- 零依赖，主入口不引用 Node 内建模块：产物在任何 ES2022 环境可用，插件的浏览器侧若
  想要容器也可直接使用。只有 `@seaveyon/dsh-di/host` 提及 `node:http` 类型，因为 DSH
  的路由处理器就是 Node 的。

## 许可证

MIT
