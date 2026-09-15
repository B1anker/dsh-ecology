/**
 * The registry is plain data; these pin down the little behaviour it has.
 */

import { describe, expect, test } from '@rstest/core'
import { ServiceCollection } from '../src/collection.js'
import { SyncDescriptor } from '../src/descriptors.js'
import { createDecorator } from '../src/identifier.js'
import { isDisposable, toDisposable } from '../src/lifecycle.js'

interface IThing {
  readonly _serviceBrand: undefined
  readonly label: string
}
const IThing = createDecorator<IThing>('collection.thing')
const IOther = createDecorator<IThing>('collection.other')

class Thing implements IThing {
  declare readonly _serviceBrand: undefined
  readonly label = 'thing'
}

describe('ServiceCollection', () => {
  test('starts from the entries it is given', () => {
    const instance: IThing = { _serviceBrand: undefined, label: 'ready' }
    const collection = new ServiceCollection([IThing, instance])
    expect(collection.has(IThing)).toBe(true)
    expect(collection.get(IThing)).toBe(instance)
    expect(collection.size).toBe(1)
  })

  test('set returns what it replaced', () => {
    const collection = new ServiceCollection()
    const descriptor = new SyncDescriptor(Thing)
    expect(collection.set(IThing, descriptor)).toBeUndefined()
    const instance: IThing = { _serviceBrand: undefined, label: 'ready' }
    expect(collection.set(IThing, instance)).toBe(descriptor)
    expect(collection.get(IThing)).toBe(instance)
  })

  test('delete, keys and forEach reflect registration order', () => {
    const collection = new ServiceCollection()
    collection.set(IOther, new SyncDescriptor(Thing))
    collection.set(IThing, new SyncDescriptor(Thing))
    expect([...collection.keys()]).toEqual([IOther, IThing])

    const seen: string[] = []
    collection.forEach((id, entry) => {
      seen.push(`${id}:${entry instanceof SyncDescriptor ? 'descriptor' : 'instance'}`)
    })
    expect(seen).toEqual(['collection.other:descriptor', 'collection.thing:descriptor'])

    expect(collection.delete(IOther)).toBe(true)
    expect(collection.delete(IOther)).toBe(false)
    expect(collection.has(IOther)).toBe(false)
    expect(collection.get(IOther)).toBeUndefined()
  })

  test('clone shares entries but not the map', () => {
    const collection = new ServiceCollection()
    const descriptor = new SyncDescriptor(Thing, ['a'], true)
    collection.set(IThing, descriptor)

    const copy = collection.clone()
    expect(copy).not.toBe(collection)
    expect(copy.get(IThing)).toBe(descriptor)

    // Overriding in the copy leaves the original alone, which is the point:
    // a test swaps a service for a double without touching production wiring.
    const double: IThing = { _serviceBrand: undefined, label: 'double' }
    copy.set(IThing, double)
    expect(collection.get(IThing)).toBe(descriptor)
    expect(copy.get(IThing)).toBe(double)
  })
})

describe('SyncDescriptor', () => {
  test('defaults to no static arguments and eager construction', () => {
    const descriptor = new SyncDescriptor(Thing)
    expect(descriptor.ctor).toBe(Thing)
    expect(descriptor.staticArguments).toEqual([])
    expect(descriptor.supportsDelayedInstantiation).toBe(false)
  })
})

describe('lifecycle', () => {
  test('isDisposable recognises exactly a callable dispose', () => {
    expect(isDisposable({ dispose() {} })).toBe(true)
    expect(isDisposable(toDisposable(() => {}))).toBe(true)
    expect(isDisposable({ dispose: 1 })).toBe(false)
    expect(isDisposable(null)).toBe(false)
    expect(isDisposable(undefined)).toBe(false)
    expect(isDisposable('dispose')).toBe(false)
    // A function with a dispose property is still not a disposable object.
    const fn = Object.assign(() => {}, { dispose() {} })
    expect(isDisposable(fn)).toBe(false)
  })

  test('toDisposable wraps a teardown', () => {
    let calls = 0
    const disposable = toDisposable(() => {
      calls += 1
    })
    disposable.dispose()
    disposable.dispose()
    expect(calls).toBe(2)
  })
})
