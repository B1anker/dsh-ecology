/**
 * The container: resolution, caching, construction, laziness, scopes, errors
 * and disposal.
 */

import { describe, expect, test } from '@rstest/core'
import { ServiceCollection } from '../src/collection.js'
import { SyncDescriptor } from '../src/descriptors.js'
import { createDecorator, inject, optional } from '../src/identifier.js'
import {
  IInstantiationService,
  InstantiationService,
  type ServicesAccessor,
} from '../src/instantiation.js'

interface IAlpha {
  readonly _serviceBrand: undefined
  name(): string
}
interface IBeta {
  readonly _serviceBrand: undefined
  value(): string
}
interface IGamma {
  readonly _serviceBrand: undefined
  readonly tag: string
}
const IAlpha = createDecorator<IAlpha>('alpha')
const IBeta = createDecorator<IBeta>('beta')
const IGamma = createDecorator<IGamma>('gamma')

class Alpha implements IAlpha {
  declare readonly _serviceBrand: undefined
  name(): string {
    return 'alpha'
  }
}

@inject(IAlpha)
class Beta implements IBeta {
  declare readonly _serviceBrand: undefined
  constructor(private readonly alpha: IAlpha) {}
  value(): string {
    return `${this.alpha.name()}+beta`
  }
}

/** Mixes injected services with values only the call site knows. */
@inject(IAlpha)
class Labelled {
  constructor(
    readonly alpha: IAlpha,
    readonly label: string,
    readonly count: number,
  ) {}
}

/** Records disposal order across a graph. */
function tracked(log: string[], tag: string) {
  return class Tracked implements IGamma {
    declare readonly _serviceBrand: undefined
    readonly tag = tag
    constructor() {
      log.push(`create ${tag}`)
    }
    dispose(): void {
      log.push(`dispose ${tag}`)
    }
  }
}

function boot(...entries: Array<[id: Parameters<ServiceCollection['set']>[0], entry: unknown]>) {
  const collection = new ServiceCollection()
  for (const [id, entry] of entries) collection.set(id, entry as never)
  return new InstantiationService(collection)
}

describe('resolution', () => {
  test('injects constructor dependencies', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)], [IBeta, new SyncDescriptor(Beta)])
    expect(services.get(IBeta).value()).toBe('alpha+beta')
  })

  test('caches resolved singletons without touching the collection', () => {
    const collection = new ServiceCollection()
    const descriptor = new SyncDescriptor(Alpha)
    collection.set(IAlpha, descriptor)
    const services = new InstantiationService(collection)

    expect(services.get(IAlpha)).toBe(services.get(IAlpha))
    // The recipe stays a recipe: a second container over the same collection
    // builds its own instance rather than inheriting this one's.
    expect(collection.get(IAlpha)).toBe(descriptor)
    expect(new InstantiationService(collection).get(IAlpha)).not.toBe(services.get(IAlpha))
  })

  test('hands back a ready instance as-is', () => {
    const ready: IAlpha = { _serviceBrand: undefined, name: () => 'ready' }
    const services = boot([IAlpha, ready], [IBeta, new SyncDescriptor(Beta)])
    expect(services.get(IAlpha)).toBe(ready)
    expect(services.get(IBeta).value()).toBe('ready+beta')
  })

  test('has never constructs anything', () => {
    let constructed = 0
    class Counted extends Alpha {
      constructor() {
        super()
        constructed += 1
      }
    }
    const services = boot([IAlpha, new SyncDescriptor(Counted)])
    expect(services.has(IAlpha)).toBe(true)
    expect(services.has(IBeta)).toBe(false)
    expect(constructed).toBe(0)
  })

  test('the container resolves itself, so a service can build collaborators', () => {
    @inject(IInstantiationService)
    class Factory {
      constructor(readonly services: IInstantiationService) {}
      make(label: string): Labelled {
        return this.services.createInstance(Labelled, label, 1)
      }
    }
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    expect(services.get(IInstantiationService)).toBe(services)
    const factory = services.createInstance(Factory)
    expect(factory.services).toBe(services)
    expect(factory.make('x').label).toBe('x')
  })

  test('a default container is empty but for itself', () => {
    const services = new InstantiationService()
    expect(services.has(IInstantiationService)).toBe(true)
    expect(services.has(IAlpha)).toBe(false)
  })
})

describe('createInstance', () => {
  test('fills injected and static parameters in order', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const made = services.createInstance(Labelled, 'store', 7)
    expect(made.alpha.name()).toBe('alpha')
    expect(made.label).toBe('store')
    expect(made.count).toBe(7)
  })

  test('a descriptor carries its own static arguments', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const made = services.createInstance(new SyncDescriptor(Labelled, ['from-descriptor', 1]))
    expect(made.label).toBe('from-descriptor')
    expect(made.count).toBe(1)
  })

  test('a class with no declarations still receives static arguments', () => {
    class Plain {
      constructor(readonly value: string) {}
    }
    expect(new InstantiationService().createInstance(Plain, 'direct').value).toBe('direct')
  })

  test('a declaration at a later position leaves the earlier ones to static arguments', () => {
    class Trailing {
      constructor(
        readonly first: string,
        readonly alpha: IAlpha,
        readonly last: string,
      ) {}
    }
    IAlpha(Trailing, undefined, 1)
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const made = services.createInstance(Trailing, 'a', 'z')
    expect(made.first).toBe('a')
    expect(made.alpha.name()).toBe('alpha')
    expect(made.last).toBe('z')

    // Too few static arguments: the unclaimed positions before the service
    // stay undefined rather than shifting the service out of its slot.
    const short = services.createInstance(Trailing)
    expect(short.first).toBeUndefined()
    expect(short.alpha.name()).toBe('alpha')
    expect(short.last).toBeUndefined()
  })

  test('surplus static arguments pass through, as new ctor(...) would', () => {
    @inject(IAlpha)
    class Rest {
      readonly rest: unknown[]
      constructor(
        readonly alpha: IAlpha,
        ...rest: unknown[]
      ) {
        this.rest = rest
      }
    }
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    expect(services.createInstance(Rest, 1, 2, 3).rest).toEqual([1, 2, 3])
  })

  test('the result is the caller’s: neither cached nor disposed with the container', () => {
    const log: string[] = []
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const a = services.createInstance(tracked(log, 'made'))
    const b = services.createInstance(tracked(log, 'made'))
    expect(a).not.toBe(b)
    services.dispose()
    expect(log).toEqual(['create made', 'create made'])
  })
})

describe('invokeFunction', () => {
  test('hands the accessor the same singletons and passes extra arguments', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const resolved = services.invokeFunction(
      (accessor: ServicesAccessor, suffix: string) => `${accessor.get(IAlpha).name()}${suffix}`,
      '!',
    )
    expect(resolved).toBe('alpha!')
    expect(services.invokeFunction((accessor) => accessor.get(IAlpha))).toBe(services.get(IAlpha))
  })

  test('the accessor answers has() without constructing', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    expect(
      services.invokeFunction((accessor) => [accessor.has(IAlpha), accessor.has(IBeta)]),
    ).toEqual([true, false])
  })
})

describe('optional dependencies', () => {
  @inject(IAlpha, optional(IBeta))
  class Tolerant {
    constructor(
      readonly alpha: IAlpha,
      readonly beta: IBeta | undefined,
      readonly label: string,
    ) {}
  }

  test('an unregistered optional position is undefined and the rest shift nothing', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    const made = services.createInstance(Tolerant, 'l')
    expect(made.alpha.name()).toBe('alpha')
    expect(made.beta).toBeUndefined()
    expect(made.label).toBe('l')
  })

  test('a registered optional position is resolved like any other', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)], [IBeta, new SyncDescriptor(Beta)])
    expect(services.createInstance(Tolerant, 'l').beta?.value()).toBe('alpha+beta')
  })

  test('an optional service registered in a parent scope is seen from a child', () => {
    const parent = boot([IAlpha, new SyncDescriptor(Alpha)], [IBeta, new SyncDescriptor(Beta)])
    const child = parent.createChild(new ServiceCollection())
    expect(child.createInstance(Tolerant, 'l').beta?.value()).toBe('alpha+beta')
  })
})

describe('delayed instantiation', () => {
  test('is not constructed until it is used, and then once', () => {
    let constructed = 0
    class Counted implements IAlpha {
      declare readonly _serviceBrand: undefined
      field = 'f'
      constructor() {
        constructed += 1
      }
      name(): string {
        return 'counted'
      }
    }
    const services = boot([IAlpha, new SyncDescriptor(Counted, [], true)])

    const lazy = services.get(IAlpha)
    expect(constructed).toBe(0)
    expect(services.get(IAlpha)).toBe(lazy)
    expect(constructed).toBe(0)

    // Methods keep the real instance as their receiver, and the work happens
    // once however many times the proxy is touched.
    expect(lazy.name()).toBe('counted')
    expect(lazy.name()).toBe('counted')
    expect((lazy as Counted).field).toBe('f')
    expect(constructed).toBe(1)
  })

  test('can depend on other services', () => {
    const services = boot(
      [IAlpha, new SyncDescriptor(Alpha)],
      [IBeta, new SyncDescriptor(Beta, [], true)],
    )
    expect(services.get(IBeta).value()).toBe('alpha+beta')
  })

  test('the proxy forwards writes, in, delete, enumeration and the prototype', () => {
    class Bag implements IGamma {
      declare readonly _serviceBrand: undefined
      tag = 'bag'
      extra?: number
    }
    const services = boot([IGamma, new SyncDescriptor(Bag, [], true)])
    const lazy = services.get(IGamma) as Bag

    lazy.extra = 3
    expect(lazy.extra).toBe(3)
    expect('extra' in lazy).toBe(true)
    expect(Object.keys(lazy).toSorted()).toEqual(['extra', 'tag'])
    expect(Object.getOwnPropertyDescriptor(lazy, 'tag')?.value).toBe('bag')
    expect(Object.getOwnPropertyDescriptor(lazy, 'missing')).toBeUndefined()
    expect(Object.getPrototypeOf(lazy)).toBe(Bag.prototype)
    delete lazy.extra
    expect('extra' in lazy).toBe(false)
    // `instanceof` goes through the prototype trap, so it holds. What the proxy
    // cannot offer is identity with the instance it stands in for.
    expect(lazy instanceof Bag).toBe(true)
    expect(lazy.tag).toBe('bag')
    expect(Object.is(lazy, Object.getPrototypeOf(lazy))).toBe(false)
  })

  test('a delayed service that was never used is never built, nor disposed', () => {
    const log: string[] = []
    const services = boot([IGamma, new SyncDescriptor(tracked(log, 'lazy'), [], true)])
    services.get(IGamma)
    services.dispose()
    expect(log).toEqual([])
  })

  test('a delayed service that was used is disposed like an eager one', () => {
    const log: string[] = []
    const services = boot([IGamma, new SyncDescriptor(tracked(log, 'lazy'), [], true)])
    expect(services.get(IGamma).tag).toBe('lazy')
    services.dispose()
    expect(log).toEqual(['create lazy', 'dispose lazy'])
  })

  test('disposal order follows construction, not resolution, for a delayed dependent', () => {
    const log: string[] = []
    const Dependency = tracked(log, 'dependency')
    @inject(IGamma)
    class Dependent implements IAlpha {
      declare readonly _serviceBrand: undefined
      constructor(readonly dependency: IGamma) {
        log.push('create dependent')
      }
      name(): string {
        return this.dependency.tag
      }
      dispose(): void {
        log.push('dispose dependent')
      }
    }
    const services = boot(
      [IGamma, new SyncDescriptor(Dependency)],
      [IAlpha, new SyncDescriptor(Dependent, [], true)],
    )
    // Resolved first, built last: touching the proxy pulls the dependency in
    // ahead of it, and disposal must take the dependent down first.
    const lazy = services.get(IAlpha)
    expect(lazy.name()).toBe('dependency')
    services.dispose()
    expect(log).toEqual([
      'create dependency',
      'create dependent',
      'dispose dependent',
      'dispose dependency',
    ])
  })

  test('a proxy first touched after dispose refuses to build', () => {
    const log: string[] = []
    const services = boot([IGamma, new SyncDescriptor(tracked(log, 'late'), [], true)])
    const lazy = services.get(IGamma)
    services.dispose()
    expect(() => lazy.tag).toThrow('The service container has been disposed (while creating gamma)')
    expect(log).toEqual([])
  })

  test('a failure inside a delayed build surfaces at first use and names the chain', () => {
    const services = boot([IBeta, new SyncDescriptor(Beta, [], true)])
    const lazy = services.get(IBeta)
    expect(() => lazy.value()).toThrow("Service 'alpha' is not registered (while creating beta)")
  })
})

describe('errors', () => {
  test('an unregistered service names the chain that needed it', () => {
    const services = boot([IBeta, new SyncDescriptor(Beta)])
    expect(() => services.get(IBeta)).toThrow(
      "Service 'alpha' is not registered (while creating beta)",
    )
    // Asked for directly, there is no chain to name.
    expect(() => services.get(IAlpha)).toThrow("Service 'alpha' is not registered")
    expect(() => services.get(IAlpha)).not.toThrow(/while creating/)
  })

  test('a dependency cycle is reported as its path', () => {
    interface ILoopA {
      readonly _serviceBrand: undefined
    }
    interface ILoopB {
      readonly _serviceBrand: undefined
    }
    const ILoopA = createDecorator<ILoopA>('loopA')
    const ILoopB = createDecorator<ILoopB>('loopB')

    @inject(ILoopB)
    class LoopA {
      declare readonly _serviceBrand: undefined
      constructor(readonly other: ILoopB) {}
    }
    @inject(ILoopA)
    class LoopB {
      declare readonly _serviceBrand: undefined
      constructor(readonly other: ILoopA) {}
    }
    const services = boot([ILoopA, new SyncDescriptor(LoopA)], [ILoopB, new SyncDescriptor(LoopB)])
    expect(() => services.get(ILoopA)).toThrow('Cyclic service dependency: loopA -> loopB -> loopA')
    // Nothing half-built is cached: the same question gets the same answer.
    expect(() => services.get(ILoopA)).toThrow(/Cyclic/)
  })

  test('a failed construction leaves nothing cached and the trail clean', () => {
    let attempts = 0
    class Flaky implements IAlpha {
      declare readonly _serviceBrand: undefined
      constructor() {
        attempts += 1
        if (attempts === 1) throw new Error('first time fails')
      }
      name(): string {
        return 'flaky'
      }
    }
    const services = boot([IAlpha, new SyncDescriptor(Flaky)], [IBeta, new SyncDescriptor(Beta)])
    expect(() => services.get(IBeta)).toThrow('first time fails')
    // A later, unrelated miss must not mention the aborted chain.
    expect(() => services.get(IGamma)).toThrow("Service 'gamma' is not registered")
    expect(() => services.get(IGamma)).not.toThrow(/while creating/)
    expect(services.get(IBeta).value()).toBe('flaky+beta')
    expect(attempts).toBe(2)
  })
})

describe('child scopes', () => {
  test('resolve their own collection first and fall back to the parent', () => {
    const parent = boot([IAlpha, new SyncDescriptor(Alpha)], [IBeta, new SyncDescriptor(Beta)])
    const override: IAlpha = { _serviceBrand: undefined, name: () => 'override' }
    const child = parent.createChild(new ServiceCollection([IAlpha, override]))

    expect(child.get(IAlpha)).toBe(override)
    expect(parent.get(IAlpha)).not.toBe(override)
    // Beta is the parent's descriptor, built by the parent with the parent's
    // Alpha: a parent-owned service does not see child overrides.
    expect(child.get(IBeta)).toBe(parent.get(IBeta))
    expect(child.get(IBeta).value()).toBe('alpha+beta')
    expect(child.has(IBeta)).toBe(true)
    expect(child.has(IGamma)).toBe(false)
  })

  test('a child registers itself as its own IInstantiationService', () => {
    const parent = new InstantiationService()
    const child = parent.createChild(new ServiceCollection())
    expect(child.get(IInstantiationService)).toBe(child)
    expect(parent.get(IInstantiationService)).toBe(parent)
  })

  test('a child-owned service built from parent services is the child’s to dispose', () => {
    const log: string[] = []
    const parent = boot([IAlpha, new SyncDescriptor(tracked(log, 'parent'))])
    const child = parent.createChild(
      new ServiceCollection([IGamma, new SyncDescriptor(tracked(log, 'child'))]),
    )
    child.get(IGamma)
    parent.get(IAlpha)

    child.dispose()
    expect(log).toEqual(['create child', 'create parent', 'dispose child'])
    // The parent is untouched and still serves.
    expect((parent.get(IAlpha) as unknown as IGamma).tag).toBe('parent')
    parent.dispose()
    expect(log.at(-1)).toBe('dispose parent')
  })

  test('disposing the parent disposes the children first', () => {
    const log: string[] = []
    const parent = boot([IAlpha, new SyncDescriptor(tracked(log, 'parent'))])
    const first = parent.createChild(
      new ServiceCollection([IGamma, new SyncDescriptor(tracked(log, 'first'))]),
    )
    const second = parent.createChild(
      new ServiceCollection([IGamma, new SyncDescriptor(tracked(log, 'second'))]),
    )
    parent.get(IAlpha)
    first.get(IGamma)
    second.get(IGamma)

    parent.dispose()
    expect(log).toEqual([
      'create parent',
      'create first',
      'create second',
      'dispose second',
      'dispose first',
      'dispose parent',
    ])
    expect(() => first.get(IGamma)).toThrow('The service container has been disposed')
  })

  test('an unregistered service reached through a child names the whole chain', () => {
    const parent = new InstantiationService()
    const child = parent.createChild(new ServiceCollection([IBeta, new SyncDescriptor(Beta)]))
    expect(() => child.get(IBeta)).toThrow(
      "Service 'alpha' is not registered (while creating beta)",
    )
  })
})

describe('disposal', () => {
  test('disposes what it built in reverse construction order, and only that', () => {
    const log: string[] = []
    const ready = Object.assign(new (tracked(log, 'ready'))(), {})
    log.length = 0
    const services = boot(
      [IAlpha, new SyncDescriptor(tracked(log, 'a'))],
      [IBeta, new SyncDescriptor(tracked(log, 'b'))],
      [IGamma, ready],
    )
    services.get(IBeta)
    services.get(IAlpha)
    services.get(IGamma)

    services.dispose()
    // `ready` was set into the collection as an instance: it belongs to whoever
    // made it and is not disposed here.
    expect(log).toEqual(['create b', 'create a', 'dispose a', 'dispose b'])
  })

  test('services without dispose are simply dropped', () => {
    const services = boot([IAlpha, new SyncDescriptor(Alpha)])
    services.get(IAlpha)
    expect(() => services.dispose()).not.toThrow()
  })

  test('is idempotent and fences every entry point afterwards', () => {
    const log: string[] = []
    const services = boot([IAlpha, new SyncDescriptor(tracked(log, 'a'))])
    services.get(IAlpha)
    services.dispose()
    services.dispose()
    expect(log).toEqual(['create a', 'dispose a'])

    const disposed = 'The service container has been disposed'
    expect(() => services.get(IAlpha)).toThrow(disposed)
    expect(() => services.createInstance(Alpha)).toThrow(disposed)
    expect(() => services.invokeFunction(() => 1)).toThrow(disposed)
    expect(() => services.createChild(new ServiceCollection())).toThrow(disposed)
    // `has` is a question about the collection, which still exists.
    expect(services.has(IAlpha)).toBe(true)
  })

  test('a disposed parent reached during a child build names the chain', () => {
    const parent = boot([IAlpha, new SyncDescriptor(Alpha)])
    const child = parent.createChild(new ServiceCollection([IBeta, new SyncDescriptor(Beta)]))
    // Dispose only the parent's side by hand: detach the child first so it
    // survives, then ask it for something that needs the parent.
    ;(parent as unknown as { children: Set<unknown> }).children.clear()
    parent.dispose()
    expect(() => child.get(IBeta)).toThrow(
      'The service container has been disposed (while creating beta)',
    )
  })
})
