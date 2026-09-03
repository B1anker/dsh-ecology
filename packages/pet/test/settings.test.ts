/**
 * Settings persistence: precedence across the two backends and graceful
 * degradation when either one is missing or hostile.
 */

import { beforeEach, describe, expect, test } from '@rstest/core'
import { createMockSettingsScopeBinder } from '@seaveyon/dsh-plugin-testkit'
import type { SettingsScopeBinder } from '../src/client/host-types.js'
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  MAX_SCALE,
  PetSettingsStore,
} from '../src/client/settings.js'

/** Minimal in-memory Storage: jsdom's localStorage without the global state. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

beforeEach(() => localStorage.clear())

describe('read precedence', () => {
  test('defaults when neither backend has anything', () => {
    const store = new PetSettingsStore({ storage: memoryStorage() })
    expect(store.getSnapshot()).toEqual(DEFAULT_CONFIG)
  })

  test('localStorage fills in when there is no binder', () => {
    const storage = memoryStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ name: '豆豆', petId: 'cat' }),
    })
    const store = new PetSettingsStore({ storage })
    expect(store.getSnapshot()).toEqual({ ...DEFAULT_CONFIG, name: '豆豆', petId: 'cat' })
  })

  test('a ready scope snapshot outranks localStorage', () => {
    const binder = createMockSettingsScopeBinder()
    binder.bind({ namespace: 'dsh-pet' }) // creates the namespace
    binder.bound.get('dsh-pet')!['name'] = 'Remote'
    const storage = memoryStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ name: 'Local' }),
    })
    const store = new PetSettingsStore({ binder, storage })
    expect(store.getSnapshot().name).toBe('Remote')
  })

  test('malformed stored JSON is ignored, not fatal', () => {
    const storage = memoryStorage({ [CONFIG_STORAGE_KEY]: '{oops' })
    const store = new PetSettingsStore({ storage })
    expect(store.getSnapshot()).toEqual(DEFAULT_CONFIG)
  })

  test('stored values are sanitized: scale is clamped, junk dropped', () => {
    const storage = memoryStorage({
      [CONFIG_STORAGE_KEY]: JSON.stringify({ scale: 99, visible: 'yes', name: 42 }),
    })
    const store = new PetSettingsStore({ storage })
    expect(store.getSnapshot()).toEqual({ ...DEFAULT_CONFIG, scale: MAX_SCALE })
  })
})

describe('write-through', () => {
  test('update writes the scope per-field and the whole record to storage', () => {
    const binder = createMockSettingsScopeBinder()
    const storage = memoryStorage()
    const store = new PetSettingsStore({ binder, storage })

    store.update({ name: 'Momo', scale: 1.5 })

    expect(binder.bound.get('dsh-pet')).toMatchObject({ name: 'Momo', scale: 1.5 })
    expect(JSON.parse(storage.getItem(CONFIG_STORAGE_KEY)!)).toMatchObject({
      name: 'Momo',
      scale: 1.5,
    })
    expect(store.getSnapshot().name).toBe('Momo')
  })

  test('a second store sees what the first one wrote through the scope', () => {
    // The double's namespaces are shared maps, so this is also how a second
    // tab would observe the write on a real loopback scope.
    const binder = createMockSettingsScopeBinder()
    new PetSettingsStore({ binder, storage: memoryStorage() }).update({ petId: 'robot' })
    const second = new PetSettingsStore({ binder, storage: memoryStorage() })
    expect(second.getSnapshot().petId).toBe('robot')
  })

  test('subscribers are notified on update', () => {
    const store = new PetSettingsStore({ storage: memoryStorage() })
    let calls = 0
    store.subscribe(() => calls++)
    store.update({ visible: false })
    expect(calls).toBe(1)
  })
})

describe('degradation', () => {
  test('a binder that throws at bind time degrades to plain storage', () => {
    const binder: SettingsScopeBinder = {
      bind() {
        throw new Error('settings RPC unavailable')
      },
    }
    const storage = memoryStorage()
    const store = new PetSettingsStore({ binder, storage })
    store.update({ petId: 'robot' })
    expect(JSON.parse(storage.getItem(CONFIG_STORAGE_KEY)!)).toMatchObject({ petId: 'robot' })
    expect(store.getSnapshot().petId).toBe('robot')
  })

  test('a storage that throws on write is survived', () => {
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error('quota')
    }
    const store = new PetSettingsStore({ storage })
    expect(() => store.update({ name: 'X' })).not.toThrow()
    expect(store.getSnapshot().name).toBe('X')
  })

  test('with no backends at all the store still works in memory', () => {
    const store = new PetSettingsStore({ storage: null as unknown as Storage })
    store.update({ visible: false })
    expect(store.getSnapshot().visible).toBe(false)
  })
})
