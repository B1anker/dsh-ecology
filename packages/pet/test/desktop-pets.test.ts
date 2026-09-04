/**
 * The imported-pets store: refresh semantics. The roster only ever changes on
 * a successful fetch, concurrent refreshes share one request, and an
 * unchanged roster never wakes subscribers.
 */

import { describe, expect, test } from '@rstest/core'
import type { DesktopPet } from '../src/client/bridge.js'
import { DesktopPetsStore, prettifyImportedPetId } from '../src/client/desktop-pets.js'
import { MOODS } from '../src/desktop.js'

/** A wire-format imported pet with every mood covered. */
function desktopPetFixture(id = 'ai-sleepy-silver-wolf') {
  return {
    id,
    moods: Object.fromEntries(
      MOODS.map((mood) => [
        mood,
        { frames: 6, frameDurationMs: 1100, url: `/sprites/${id}/${mood}.png` },
      ]),
    ),
  }
}

/** A fetch stub that counts calls and answers with the given pets envelope. */
function fetchStub(impl: () => Promise<Response>) {
  let calls = 0
  const fn = () => {
    calls += 1
    return impl()
  }
  return { calls: () => calls, fn: fn as unknown as typeof fetch }
}

function petsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ pets: ids.map((id) => desktopPetFixture(id)) }))
}

describe('DesktopPetsStore', () => {
  test('starts empty and stays observable', () => {
    const store = new DesktopPetsStore()
    expect(store.getSnapshot()).toEqual([])
    expect(store.find('anything')).toBeUndefined()
  })

  test('a successful refresh publishes the roster and notifies subscribers', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['ai-sleepy-silver-wolf'])))
    const store = new DesktopPetsStore({ fetchFn: stub.fn, baseUrl: 'http://127.0.0.1:9' })
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    await store.refresh()

    expect(notifications).toBe(1)
    const pets = store.getSnapshot()
    expect(pets.map((pet: DesktopPet) => pet.id)).toEqual(['ai-sleepy-silver-wolf'])
    expect(store.find('ai-sleepy-silver-wolf')?.moods.idle.url).toBe(
      'http://127.0.0.1:9/sprites/ai-sleepy-silver-wolf/idle.png',
    )
  })

  test('a failed refresh keeps the previous roster and notifies nobody', async () => {
    let online = true
    const stub = fetchStub(() =>
      online ? Promise.resolve(petsResponse(['wolf'])) : Promise.reject(new Error('gone')),
    )
    const store = new DesktopPetsStore({ fetchFn: stub.fn })
    await store.refresh()
    const before = store.getSnapshot()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    online = false
    await store.refresh()

    expect(store.getSnapshot()).toBe(before)
    expect(notifications).toBe(0)
  })

  test('an unchanged roster is not republished', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'])))
    const store = new DesktopPetsStore({ fetchFn: stub.fn })
    await store.refresh()
    const before = store.getSnapshot()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    await store.refresh()

    expect(store.getSnapshot()).toBe(before)
    expect(notifications).toBe(0)
  })

  test('concurrent refreshes share a single in-flight request', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'])))
    const store = new DesktopPetsStore({ fetchFn: stub.fn })

    await Promise.all([store.refresh(), store.refresh(), store.refresh()])

    expect(stub.calls()).toBe(1)
    expect(store.getSnapshot()).toHaveLength(1)
  })
})

describe('prettifyImportedPetId', () => {
  test('hyphenated slugs become title-case words', () => {
    expect(prettifyImportedPetId('ai-sleepy-silver-wolf')).toBe('Ai Sleepy Silver Wolf')
  })

  test('underscores split too, and an all-separator id falls back to itself', () => {
    expect(prettifyImportedPetId('my_pet')).toBe('My Pet')
    expect(prettifyImportedPetId('---')).toBe('---')
  })
})
