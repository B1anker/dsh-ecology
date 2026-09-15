/**
 * Factory recipes: closure-built services that take part in resolution like
 * constructed ones.
 */

import { describe, expect, test } from '@rstest/core'
import { ServiceCollection } from '../src/collection.js'
import { FactoryDescriptor, SyncDescriptor } from '../src/descriptors.js'
import { createDecorator, inject } from '../src/identifier.js'
import { InstantiationService } from '../src/instantiation.js'

interface IClock {
  readonly _serviceBrand: undefined
  now(): number
}
interface IStore {
  readonly _serviceBrand: undefined
  readonly createdAt: number
  dispose?(): void
}
const IClock = createDecorator<IClock>('factory.clock')
const IStore = createDecorator<IStore>('factory.store')
const IReport = createDecorator<{ readonly text: string }>('factory.report')

function createStore(options: { now: () => number; onDispose?: () => void }): IStore {
  return {
    _serviceBrand: undefined,
    createdAt: options.now(),
    dispose: options.onDispose,
  }
}

describe('FactoryDescriptor', () => {
  test('is called once, with an accessor over the graph, and cached', () => {
    let calls = 0
    const collection = new ServiceCollection()
    collection.set(IClock, { _serviceBrand: undefined, now: () => 42 })
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) => {
        calls += 1
        return createStore({ now: accessor.get(IClock).now })
      }),
    )
    const services = new InstantiationService(collection)

    expect(services.get(IStore).createdAt).toBe(42)
    expect(services.get(IStore)).toBe(services.get(IStore))
    expect(calls).toBe(1)
  })

  test('defaults to eager and can be delayed', () => {
    const descriptor = new FactoryDescriptor(() => 1)
    expect(descriptor.supportsDelayedInstantiation).toBe(false)

    let built = 0
    const collection = new ServiceCollection()
    collection.set(
      IReport,
      new FactoryDescriptor(() => {
        built += 1
        return { text: 'late' }
      }, true),
    )
    const services = new InstantiationService(collection)
    const lazy = services.get(IReport)
    expect(built).toBe(0)
    expect(lazy.text).toBe('late')
    expect(built).toBe(1)
  })

  test('the accessor answers has() and lets a factory fall back', () => {
    const collection = new ServiceCollection()
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) =>
        createStore({ now: accessor.has(IClock) ? accessor.get(IClock).now : () => 0 }),
      ),
    )
    expect(new InstantiationService(collection).get(IStore).createdAt).toBe(0)
  })

  test('a class may depend on a factory-built service and vice versa', () => {
    @inject(IStore)
    class Report {
      readonly text: string
      constructor(store: IStore) {
        this.text = `created at ${store.createdAt}`
      }
    }
    const collection = new ServiceCollection()
    collection.set(
      IClock,
      new FactoryDescriptor(() => ({ _serviceBrand: undefined, now: () => 7 })),
    )
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) => createStore({ now: accessor.get(IClock).now })),
    )
    collection.set(IReport, new SyncDescriptor(Report))
    expect(new InstantiationService(collection).get(IReport).text).toBe('created at 7')
  })

  test('what a factory pulls is recorded in the chain', () => {
    const collection = new ServiceCollection()
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) => createStore({ now: accessor.get(IClock).now })),
    )
    const services = new InstantiationService(collection)
    expect(() => services.get(IStore)).toThrow(
      "Service 'factory.clock' is not registered (while creating factory.store)",
    )
  })

  test('a cycle through a factory is reported as its path', () => {
    const collection = new ServiceCollection()
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) => {
        accessor.get(IReport)
        return createStore({ now: () => 0 })
      }),
    )
    collection.set(
      IReport,
      new FactoryDescriptor((accessor) => ({ text: String(accessor.get(IStore).createdAt) })),
    )
    expect(() => new InstantiationService(collection).get(IStore)).toThrow(
      'Cyclic service dependency: factory.store -> factory.report -> factory.store',
    )
  })

  test('the result is disposed with the container, after what it depended on was built', () => {
    const log: string[] = []
    const collection = new ServiceCollection()
    collection.set(
      IClock,
      new FactoryDescriptor(() => {
        log.push('create clock')
        return { _serviceBrand: undefined, now: () => 1, dispose: () => log.push('dispose clock') }
      }),
    )
    collection.set(
      IStore,
      new FactoryDescriptor((accessor) =>
        createStore({ now: accessor.get(IClock).now, onDispose: () => log.push('dispose store') }),
      ),
    )
    const services = new InstantiationService(collection)
    services.get(IStore)
    services.dispose()
    expect(log).toEqual(['create clock', 'dispose store', 'dispose clock'])
  })

  test('createInstance runs a factory descriptor without owning the result', () => {
    const log: string[] = []
    const collection = new ServiceCollection()
    collection.set(IClock, { _serviceBrand: undefined, now: () => 3 })
    const services = new InstantiationService(collection)
    const made = services.createInstance(
      new FactoryDescriptor((accessor) =>
        createStore({ now: accessor.get(IClock).now, onDispose: () => log.push('dispose') }),
      ),
    )
    expect(made.createdAt).toBe(3)
    services.dispose()
    expect(log).toEqual([])
  })
})
