/**
 * The desktop-pets store: refresh semantics. The roster only ever changes on
 * a successful fetch, concurrent refreshes share one request, and an
 * unchanged roster never wakes subscribers. The status half of the snapshot
 * (`unknown` → `online`/`offline`) is what lets the picker tell "desktop
 * unreachable" apart from "no answer yet".
 */

import { describe, expect, test } from '@rstest/core'
import { DesktopPetsStore, prettifyImportedPetId } from '../src/client/desktop-pets.js'
import { MOODS } from '../src/desktop.js'

/** A wire-format desktop pet with every mood covered. */
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

function petsResponse(ids: string[], eventsUrl?: string): Response {
  const envelope: Record<string, unknown> = { pets: ids.map((id) => desktopPetFixture(id)) }
  if (eventsUrl !== undefined) envelope['eventsUrl'] = eventsUrl
  return new Response(JSON.stringify(envelope))
}

/** A fake liveness-stream source: recorded url, scriptable handlers, mutable readyState. */
function fakeEventSourceFactory() {
  const created: {
    url: string
    readyState: number
    closes: number
    onopen: (() => void) | null
    onerror: (() => void) | null
  }[] = []
  const factory = (url: string) => {
    const source = {
      url,
      readyState: 0,
      closes: 0,
      onopen: null as (() => void) | null,
      onerror: null as (() => void) | null,
      close() {
        source.closes += 1
      },
    }
    created.push(source)
    return source
  }
  return { created, factory }
}

describe('DesktopPetsStore', () => {
  test('starts unknown and empty, and stays observable', () => {
    const store = new DesktopPetsStore()
    expect(store.getSnapshot()).toEqual({ pets: [], status: 'unknown' })
    expect(store.find('anything')).toBeUndefined()
  })

  test('a successful refresh publishes the roster, flips online, and notifies', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['ai-sleepy-silver-wolf'])))
    const store = new DesktopPetsStore({ fetchFn: stub.fn, baseUrl: 'http://127.0.0.1:9' })
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    await store.refresh()

    expect(notifications).toBe(1)
    const snapshot = store.getSnapshot()
    expect(snapshot.status).toBe('online')
    expect(snapshot.pets.map((pet) => pet.id)).toEqual(['ai-sleepy-silver-wolf'])
    expect(store.find('ai-sleepy-silver-wolf')?.moods.idle.url).toBe(
      'http://127.0.0.1:9/sprites/ai-sleepy-silver-wolf/idle.png',
    )
  })

  test('a failed refresh flips offline but keeps the previous roster', async () => {
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

    expect(store.getSnapshot().status).toBe('offline')
    expect(store.getSnapshot().pets).toBe(before.pets)
    expect(notifications).toBe(1) // the status change, not a roster change
  })

  test('an unchanged outcome is not republished', async () => {
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

  test('a repeated failure after the first offline flip is also not republished', async () => {
    const stub = fetchStub(() => Promise.reject(new Error('gone')))
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
    expect(store.getSnapshot().pets).toHaveLength(1)
  })

  test('an advertised eventsUrl opens one liveness stream, resolved against the origin', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'], '/events')))
    const events = fakeEventSourceFactory()
    const store = new DesktopPetsStore({
      fetchFn: stub.fn,
      baseUrl: 'http://127.0.0.1:9',
      eventSourceFn: events.factory,
    })

    await store.refresh()
    await store.refresh()

    expect(events.created).toHaveLength(1)
    expect(events.created[0]?.url).toBe('http://127.0.0.1:9/events')
  })

  test('a roster without eventsUrl opens no stream', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'])))
    const events = fakeEventSourceFactory()
    const store = new DesktopPetsStore({ fetchFn: stub.fn, eventSourceFn: events.factory })

    await store.refresh()

    expect(events.created).toHaveLength(0)
  })

  test('a dropped stream flips offline at once but keeps the roster', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'], '/events')))
    const events = fakeEventSourceFactory()
    const store = new DesktopPetsStore({ fetchFn: stub.fn, eventSourceFn: events.factory })
    await store.refresh()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    events.created[0]!.onerror!()

    const snapshot = store.getSnapshot()
    expect(snapshot.status).toBe('offline')
    expect(snapshot.pets.map((pet) => pet.id)).toEqual(['wolf'])
    expect(notifications).toBe(1)
  })

  test('a reopened stream refreshes back to online', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'], '/events')))
    const events = fakeEventSourceFactory()
    const store = new DesktopPetsStore({ fetchFn: stub.fn, eventSourceFn: events.factory })
    await store.refresh()
    events.created[0]!.onerror!()
    expect(store.getSnapshot().status).toBe('offline')

    events.created[0]!.onopen!()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getSnapshot().status).toBe('online')
    expect(events.created).toHaveLength(1) // still the same stream, no duplicate
  })

  test('a stream refused outright (CLOSED) is closed once and never retried', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'], '/events')))
    const events = fakeEventSourceFactory()
    const store = new DesktopPetsStore({ fetchFn: stub.fn, eventSourceFn: events.factory })
    await store.refresh()
    const source = events.created[0]!
    source.readyState = 2

    source.onerror!()
    await store.refresh()

    expect(source.closes).toBe(1)
    expect(events.created).toHaveLength(1)
    expect(store.getSnapshot().status).toBe('online') // polling still carries the state
  })

  test('eventSourceFn: null forces polling-only even when the stream is advertised', async () => {
    const stub = fetchStub(() => Promise.resolve(petsResponse(['wolf'], '/events')))
    const store = new DesktopPetsStore({ fetchFn: stub.fn, eventSourceFn: null })

    await store.refresh()

    expect(store.getSnapshot().status).toBe('online')
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
