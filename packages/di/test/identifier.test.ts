/**
 * Service identifiers and the declarations they leave on a constructor.
 */

import { describe, expect, test } from '@rstest/core'
import {
  createDecorator,
  DI_DEPENDENCIES,
  DI_TARGET,
  getServiceDependencies,
  inject,
  optional,
  type ServiceIdentifier,
} from '../src/identifier.js'

interface IAlpha {
  readonly _serviceBrand: undefined
}
interface IBeta {
  readonly _serviceBrand: undefined
}
const IAlpha = createDecorator<IAlpha>('identifier.alpha')
const IBeta = createDecorator<IBeta>('identifier.beta')

describe('createDecorator', () => {
  test('returns one identifier per name, however many times it is asked', () => {
    expect(createDecorator<IAlpha>('identifier.alpha')).toBe(IAlpha)
    expect(createDecorator<unknown>('identifier.other')).not.toBe(IAlpha)
  })

  test('prints as its name, for error messages and diagnostics', () => {
    expect(String(IAlpha)).toBe('identifier.alpha')
    expect(`${IBeta}`).toBe('identifier.beta')
  })

  test('acts as a legacy parameter decorator on constructor parameters', () => {
    class Legacy {
      constructor(
        readonly beta: IBeta,
        readonly alpha: IAlpha,
      ) {}
    }
    // What `experimentalDecorators` emits for `constructor(@IBeta b, @IAlpha a)`:
    // one call per decorated parameter, last parameter first.
    IAlpha(Legacy, undefined, 1)
    IBeta(Legacy, undefined, 0)

    expect(getServiceDependencies(Legacy)).toEqual([
      { id: IBeta, index: 0, optional: false },
      { id: IAlpha, index: 1, optional: false },
    ])
  })

  test('refuses to decorate anything but a constructor parameter', () => {
    class Target {
      value = 1
    }
    const misuse = IAlpha as unknown as (...args: unknown[]) => void
    // A property decorator receives two arguments…
    expect(() => misuse(Target.prototype, 'value')).toThrow(
      '@identifier.alpha can only decorate a constructor parameter',
    )
    // …a method parameter decorator receives a prototype, not a constructor…
    expect(() => misuse(Target.prototype, 'method', 0)).toThrow(/constructor parameter/)
    // …and a class decorator receives one.
    expect(() => misuse(Target)).toThrow(/constructor parameter/)
  })
})

describe('inject', () => {
  test('declares the leading constructor positions, in order', () => {
    @inject(IAlpha, IBeta)
    class Decorated {
      constructor(
        readonly alpha: IAlpha,
        readonly beta: IBeta,
        readonly label: string,
      ) {}
    }
    expect(getServiceDependencies(Decorated)).toEqual([
      { id: IAlpha, index: 0, optional: false },
      { id: IBeta, index: 1, optional: false },
    ])
  })

  test('works as a plain function call, without decorator syntax', () => {
    class Plain {
      constructor(readonly beta: IBeta) {}
    }
    inject(IBeta)(Plain)
    expect(getServiceDependencies(Plain)).toEqual([{ id: IBeta, index: 0, optional: false }])
  })

  test('marks optional positions', () => {
    @inject(IAlpha, optional(IBeta))
    class Tolerant {
      constructor(
        readonly alpha: IAlpha,
        readonly beta: IBeta | undefined,
      ) {}
    }
    expect(getServiceDependencies(Tolerant)).toEqual([
      { id: IAlpha, index: 0, optional: false },
      { id: IBeta, index: 1, optional: true },
    ])
  })

  test('replaces an earlier declaration on the same class', () => {
    class Redeclared {
      constructor(readonly first: unknown = undefined) {}
    }
    inject(IAlpha)(Redeclared)
    inject(IBeta, IAlpha)(Redeclared)
    expect(getServiceDependencies(Redeclared).map((d) => d.id)).toEqual([IBeta, IAlpha])
  })

  test('a subclass declares nothing until it declares for itself', () => {
    @inject(IAlpha)
    class Parent {
      constructor(readonly alpha: IAlpha) {}
    }
    class Child extends Parent {
      constructor(
        alpha: IAlpha,
        readonly extra: string,
      ) {
        super(alpha)
      }
    }
    // Static properties are inherited through the prototype chain, but the
    // declaration names the class it was written for, so Child reads as empty…
    expect(getServiceDependencies(Child)).toEqual([])
    expect(getServiceDependencies(Parent)).toHaveLength(1)
    // …until it declares its own list, which does not disturb the parent's.
    inject(IAlpha)(Child)
    expect(getServiceDependencies(Child)).toHaveLength(1)
    expect((Child as unknown as Record<symbol, unknown>)[DI_TARGET]).toBe(Child)
    expect((Parent as unknown as Record<symbol, unknown>)[DI_TARGET]).toBe(Parent)
  })

  test('refuses a non-class target', () => {
    expect(() => inject(IAlpha)({} as unknown as Function)).toThrow(
      'inject(...) can only be applied to a class',
    )
  })

  test('the declaration is stored under well-known symbols', () => {
    @inject(IAlpha)
    class Stored {
      constructor(readonly alpha: IAlpha) {}
    }
    const raw = Stored as unknown as Record<symbol, unknown>
    expect(raw[DI_TARGET]).toBe(Stored)
    expect(raw[DI_DEPENDENCIES]).toEqual([{ id: IAlpha, index: 0, optional: false }])
    // `Symbol.for` keys: another copy of this package reads the same slots.
    expect(Symbol.for('@seaveyon/dsh-di:target')).toBe(DI_TARGET)
    expect(Symbol.for('@seaveyon/dsh-di:dependencies')).toBe(DI_DEPENDENCIES)
  })
})

describe('getServiceDependencies', () => {
  test('is empty for a class that declared nothing', () => {
    class Bare {
      readonly bare = true
    }
    expect(getServiceDependencies(Bare)).toEqual([])
  })

  test('sorts by parameter index whatever order the declarations arrived in', () => {
    class Shuffled {
      constructor(
        readonly a: IAlpha,
        readonly b: IBeta,
        readonly c: IAlpha,
      ) {}
    }
    const ids: Array<[ServiceIdentifier<unknown>, number]> = [
      [IAlpha, 2],
      [IBeta, 1],
      [IAlpha, 0],
    ]
    for (const [id, index] of ids) id(Shuffled, undefined, index)
    expect(getServiceDependencies(Shuffled).map((d) => d.index)).toEqual([0, 1, 2])
    // The returned list is a copy: mutating it changes nothing.
    const list = getServiceDependencies(Shuffled) as unknown[]
    list.length = 0
    expect(getServiceDependencies(Shuffled)).toHaveLength(3)
  })
})
