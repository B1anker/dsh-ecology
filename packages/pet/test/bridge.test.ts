/**
 * The desktop-companion bridge: gating on the setting, payload shape, and the
 * fire-and-forget guarantee. fetch is injected as a stub, so "the desktop app
 * isn't running" is simulated by a rejecting promise rather than a real port.
 */

import { describe, expect, test } from '@rstest/core'
import {
  DEFAULT_ENDPOINT,
  DESKTOP_BASE_URL,
  DESKTOP_COMPANION_PORT,
  DesktopBridge,
  fetchDesktopPets,
} from '../src/client/bridge.js'
import type { ConversationSnapshotSlice } from '../src/client/host-types.js'
import { PetStateMachine } from '../src/client/mood.js'
import { PetSettingsStore } from '../src/client/settings.js'
import { MOODS } from '../src/desktop.js'

interface FetchCall {
  url: unknown
  init: RequestInit | undefined
}

/** A fetch stub that records calls and resolves or rejects as asked. */
function fetchStub(impl: () => Promise<Response> = () => Promise.resolve(new Response())) {
  const calls: FetchCall[] = []
  const fn = (url: unknown, init?: RequestInit) => {
    calls.push({ url, init })
    return impl()
  }
  return { calls, fn: fn as unknown as typeof fetch }
}

function snap(overrides: Partial<ConversationSnapshotSlice> = {}): ConversationSnapshotSlice {
  return {
    running: false,
    runningCalls: [],
    pending: [],
    promptError: null,
    lastAgentError: null,
    turnEnds: new Map(),
    turnTimings: new Map(),
    ...overrides,
  }
}

/** A settings store with a private in-memory backend, so no state leaks between tests. */
function bareSettings(): PetSettingsStore {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => Array.from(map.keys())[index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
  return new PetSettingsStore({ storage })
}

/** The full wiring under test: store + machine + bridge + the fetch record. */
function wire(
  options: { impl?: () => Promise<Response>; endpoint?: string; companionEnabled?: boolean } = {},
) {
  const stub = fetchStub(options.impl)
  const settings = bareSettings()
  // The bridge announces on construction when the toggle allows it, so a test
  // that wants the toggle off must set it before the bridge exists.
  if (options.companionEnabled !== undefined) {
    settings.update({ companionEnabled: options.companionEnabled })
  }
  const machine = new PetStateMachine()
  const bridge = new DesktopBridge({
    settings,
    machine,
    fetchFn: stub.fn,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
  })
  return { stub, settings, machine, bridge }
}

describe('gating', () => {
  test('with the toggle off, no state change ever sends a request', () => {
    const { stub, settings, machine, bridge } = wire({ companionEnabled: false })

    machine.update(snap({ running: true }))
    machine.pet()
    settings.update({ name: 'Momo', petId: 'cat' })

    expect(stub.calls).toHaveLength(0)
    bridge.dispose()
  })

  test('the toggle defaults to on: a fresh bridge announces state immediately', () => {
    const { stub, bridge } = wire()

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toBe(DEFAULT_ENDPOINT)
    expect(stub.calls[0]?.init?.method).toBe('POST')
    expect(stub.calls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({
      mood: 'idle',
      petId: 'blob',
      name: 'Mochi',
    })
    bridge.dispose()
  })

  test('flipping the toggle on later announces the current state at that moment', () => {
    const { stub, settings, bridge } = wire({ companionEnabled: false })

    settings.update({ companionEnabled: true })

    expect(stub.calls).toHaveLength(1)
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toMatchObject({ mood: 'idle' })
    bridge.dispose()
  })

  test('flipping the toggle off stops the traffic', () => {
    const { stub, settings, machine, bridge } = wire() // on by default: 1 announcement

    settings.update({ companionEnabled: false })
    machine.update(snap({ running: true }))

    expect(stub.calls).toHaveLength(1) // only the announcement from construction
    bridge.dispose()
  })

  test('a disposed bridge goes quiet even with the toggle on', () => {
    const { stub, machine, bridge } = wire()

    bridge.dispose()
    machine.update(snap({ running: true }))

    expect(stub.calls).toHaveLength(1)
  })
})

describe('state pushes', () => {
  test('a mood change POSTs the new state to the companion endpoint', () => {
    const { stub, machine, bridge } = wire()

    machine.update(snap({ running: true, runningCalls: [{ name: 'bash' }] }))

    expect(stub.calls).toHaveLength(2)
    expect(JSON.parse(String(stub.calls[1]?.init?.body))).toEqual({
      mood: 'working',
      petId: 'blob',
      name: 'Mochi',
    })
    bridge.dispose()
  })

  test('renaming the pet pushes the new name; species changes too', () => {
    const { stub, settings, bridge } = wire()

    settings.update({ name: '豆豆', petId: 'cat' })

    expect(stub.calls).toHaveLength(2)
    expect(JSON.parse(String(stub.calls[1]?.init?.body))).toEqual({
      mood: 'idle',
      petId: 'cat',
      name: '豆豆',
    })
    bridge.dispose()
  })

  test('notifications that change nothing are not re-sent', () => {
    const { stub, settings, machine, bridge } = wire()

    // Same effective state arriving repeatedly: re-writing the same name is
    // not part of the payload diff, and re-feeding an unchanged snapshot
    // keeps the mood.
    settings.update({ name: 'Mochi' })
    machine.update(snap())
    machine.tick()

    expect(stub.calls).toHaveLength(1)
    bridge.dispose()
  })

  test('the endpoint is injectable, and the port constant anchors the default', () => {
    const { stub, bridge } = wire({ endpoint: 'http://127.0.0.1:9/state' })

    expect(stub.calls[0]?.url).toBe('http://127.0.0.1:9/state')
    expect(DEFAULT_ENDPOINT).toBe(`http://127.0.0.1:${DESKTOP_COMPANION_PORT}/state`)
    bridge.dispose()
  })
})

describe('fire-and-forget', () => {
  test('a rejected fetch (app not running) throws nothing and stops nothing', () => {
    const { stub, settings, machine, bridge } = wire({
      impl: () => Promise.reject(new Error('connection refused')),
    })

    expect(() => settings.update({ name: 'Momo' })).not.toThrow()
    expect(() => machine.update(snap({ running: true }))).not.toThrow()

    // Both changes were attempted; the failure of the first changed nothing.
    expect(stub.calls).toHaveLength(3)
    expect(JSON.parse(String(stub.calls[2]?.init?.body))).toMatchObject({ mood: 'thinking' })
    bridge.dispose()
  })

  test('a fetch that throws synchronously is survived too', () => {
    const { stub, settings, bridge } = wire({
      impl: () => {
        throw new Error('fetch itself exploded')
      },
    })

    expect(() => settings.update({ name: 'Momo' })).not.toThrow()
    expect(stub.calls).toHaveLength(2) // the announcement plus the rename
    bridge.dispose()
  })
})

/** A wire-format imported pet with every mood covered. */
function desktopPetFixture(id = 'ai-sleepy-silver-wolf', frames = 6, frameDurationMs = 1100) {
  return {
    id,
    moods: Object.fromEntries(
      MOODS.map((mood) => [mood, { frames, frameDurationMs, url: `/sprites/${id}/${mood}.png` }]),
    ),
  }
}

describe('fetchDesktopPets', () => {
  test('returns the roster with sprite URLs resolved against the bridge origin', async () => {
    const stub = fetchStub(() =>
      Promise.resolve(
        new Response(JSON.stringify({ pets: [desktopPetFixture()] }), { status: 200 }),
      ),
    )

    const pets = await fetchDesktopPets({ fetchFn: stub.fn })

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toBe(`${DESKTOP_BASE_URL}/pets`)
    expect(stub.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(pets).toHaveLength(1)
    expect(pets?.[0]?.id).toBe('ai-sleepy-silver-wolf')
    for (const mood of MOODS) {
      expect(pets?.[0]?.moods[mood]).toEqual({
        frames: 6,
        frameDurationMs: 1100,
        url: `${DESKTOP_BASE_URL}/sprites/ai-sleepy-silver-wolf/${mood}.png`,
      })
    }
  })

  test('an injected base URL anchors both the request and the resolved sprites', async () => {
    const stub = fetchStub(() =>
      Promise.resolve(
        new Response(JSON.stringify({ pets: [desktopPetFixture()] }), { status: 200 }),
      ),
    )

    const pets = await fetchDesktopPets({ fetchFn: stub.fn, baseUrl: 'http://127.0.0.1:9' })

    expect(stub.calls[0]?.url).toBe('http://127.0.0.1:9/pets')
    expect(pets?.[0]?.moods.idle.url).toBe(
      'http://127.0.0.1:9/sprites/ai-sleepy-silver-wolf/idle.png',
    )
  })

  test('the desktop app not running (rejected fetch) resolves to null', async () => {
    const stub = fetchStub(() => Promise.reject(new Error('connection refused')))
    await expect(fetchDesktopPets({ fetchFn: stub.fn })).resolves.toBeNull()
  })

  test('a non-200 response resolves to null', async () => {
    const stub = fetchStub(() => Promise.resolve(new Response('nope', { status: 500 })))
    await expect(fetchDesktopPets({ fetchFn: stub.fn })).resolves.toBeNull()
  })

  test('unparseable JSON resolves to null', async () => {
    const stub = fetchStub(() => Promise.resolve(new Response('not json', { status: 200 })))
    await expect(fetchDesktopPets({ fetchFn: stub.fn })).resolves.toBeNull()
  })

  test.each([
    ['a non-object body', 42],
    ['a body without a pets array', { pets: 'nope' }],
  ])('a well-formed but off-contract body (%s) resolves to null', async (_label, body) => {
    const stub = fetchStub(() => Promise.resolve(new Response(JSON.stringify(body))))
    await expect(fetchDesktopPets({ fetchFn: stub.fn })).resolves.toBeNull()
  })

  test('broken pets are dropped one by one; healthy ones survive', async () => {
    const healthy = desktopPetFixture('healthy')
    const badFrames = desktopPetFixture('bad-frames')
    badFrames.moods['idle'] = { frames: 0, frameDurationMs: 100, url: '/x.png' }
    const badDuration = desktopPetFixture('bad-duration')
    badDuration.moods['pet'] = { frames: 2, frameDurationMs: 0, url: '/x.png' }
    const badUrl = desktopPetFixture('bad-url')
    badUrl.moods['sad'] = { frames: 2, frameDurationMs: 100, url: 'https://evil.example/x.png' }
    const missingMood = desktopPetFixture('missing-mood')
    delete missingMood.moods['celebrating']
    const body = {
      pets: [healthy, badFrames, badDuration, badUrl, missingMood, 'junk', { id: 7 }],
    }
    const stub = fetchStub(() => Promise.resolve(new Response(JSON.stringify(body))))

    const pets = await fetchDesktopPets({ fetchFn: stub.fn })

    expect(pets?.map((pet) => pet.id)).toEqual(['healthy'])
  })

  test('an online desktop with no imports answers with an empty roster, not null', async () => {
    const stub = fetchStub(() => Promise.resolve(new Response(JSON.stringify({ pets: [] }))))
    await expect(fetchDesktopPets({ fetchFn: stub.fn })).resolves.toEqual([])
  })

  test('a fetch that never answers loses the race to the timeout', async () => {
    const stub = fetchStub(() => new Promise<Response>(() => {}))
    const started = Date.now()
    const result = await fetchDesktopPets({ fetchFn: stub.fn, timeoutMs: 25 })
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
