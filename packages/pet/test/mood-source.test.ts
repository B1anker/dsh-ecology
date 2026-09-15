/**
 * The mood source: the wiring that replaced the page overlay as the state
 * machine's driver. Session snapshots flow into the machine, session swaps
 * re-subscribe without leaking, and the injected scheduler's tick advances
 * time-driven transitions. Driven through the testkit's client doubles, the
 * way the shell would drive it.
 */

import { describe, expect, test } from '@rstest/core'
import {
  createMockClientRuntime,
  createMockObservable,
  createMockSessions,
} from '@seaveyon/dsh-plugin-testkit'
import type { ConversationSnapshotSlice, SessionSnapshotSlice } from '../src/client/host-types.js'
import { PetStateMachine } from '../src/client/mood.js'
import {
  detectSessionsShape,
  MOOD_TICK_MS,
  SessionFaceAdapter,
  wireMoodSource,
} from '../src/client/mood-source.js'

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

describe('wireMoodSource', () => {
  test('without a sessions service the machine idles and dispose is a no-op', () => {
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(undefined, machine)

    expect(machine.getSnapshot()).toBe('idle')
    expect(() => dispose()).not.toThrow()
  })

  test('the current snapshot is fed immediately and updates follow publishes', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>()
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(runtime.sessions, machine, { schedule: () => () => {} })

    expect(machine.getSnapshot()).toBe('idle')

    runtime.sessions.publish(snap({ running: true }))
    expect(machine.getSnapshot()).toBe('thinking')

    runtime.sessions.publish(snap({ running: true, runningCalls: [{ name: 'bash' }] }))
    expect(machine.getSnapshot()).toBe('working')
    dispose()
  })

  test('a session swap resubscribes without leaking the old session', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>()
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(runtime.sessions, machine, { schedule: () => () => {} })
    const oldSession = runtime.sessions.currentProvideInfo!.getSnapshot()!.hooks.session

    const newSession = createMockObservable<ConversationSnapshotSlice | null>(null)
    runtime.sessions.select(null)
    expect(machine.getSnapshot()).toBe('idle')
    runtime.sessions.select({ hooks: { session: newSession } })

    newSession.set(snap({ running: true, runningCalls: [{ name: 'read' }] }))
    expect(machine.getSnapshot()).toBe('working')
    // The old session observable no longer drives — and no longer holds — us.
    expect(oldSession.listeners.size).toBe(0)
    expect(newSession.listeners.size).toBe(1)
    dispose()
  })

  test('the scheduler drives time-driven transitions on the tick', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>()
    let now = 0
    const machine = new PetStateMachine({ now: () => now })
    let tick: (() => void) | null = null
    const dispose = wireMoodSource(runtime.sessions, machine, {
      schedule: (callback) => {
        tick = callback
        return () => {}
      },
    })

    machine.pet()
    expect(machine.getSnapshot()).toBe('pet')

    now += 10_000 // past the pet pulse
    tick!()
    expect(machine.getSnapshot()).toBe('idle')
    dispose()
  })

  test('the default interval is one second, overridable for tests', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>()
    const machine = new PetStateMachine()
    const intervals: number[] = []
    const dispose = wireMoodSource(runtime.sessions, machine, {
      schedule: (_callback, ms) => {
        intervals.push(ms)
        return () => {}
      },
    })
    expect(intervals).toEqual([MOOD_TICK_MS])
    dispose()
  })

  test('dispose drops both subscriptions and cancels the tick', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>()
    const machine = new PetStateMachine()
    let cancelled = false
    const dispose = wireMoodSource(runtime.sessions, machine, {
      schedule: () => () => {
        cancelled = true
      },
    })
    const session = runtime.sessions.currentProvideInfo!.getSnapshot()!.hooks.session

    dispose()

    expect(cancelled).toBe(true)
    expect(session.listeners.size).toBe(0)
    runtime.sessions.publish(snap({ running: true }))
    expect(machine.getSnapshot()).toBe('idle')
  })
})

describe('detectSessionsShape', () => {
  test('names each host generation and refuses what it does not know', () => {
    expect(detectSessionsShape(undefined)).toBe('unknown')
    expect(detectSessionsShape({})).toBe('unknown')
    // 0.1.5+ needs the pair; a list alone is not enough to reach a face.
    expect(detectSessionsShape({ list: createMockObservable({}) })).toBe('unknown')
    expect(
      detectSessionsShape(
        createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>(
          null,
          undefined,
          'provide-info',
        ),
      ),
    ).toBe('provide-info')
    expect(
      detectSessionsShape(
        createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>(
          null,
          undefined,
          'binding',
        ),
      ),
    ).toBe('binding')
    // The richer channel wins when a shell exposes both.
    expect(
      detectSessionsShape(createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>()),
    ).toBe('provide-info')
  })
})

describe('SessionFaceAdapter', () => {
  test('synthesizes the conversation slice from a session face snapshot', () => {
    let now = 1000
    const adapter = new SessionFaceAdapter(() => now)
    const idle = adapter.adapt({ running: false })
    expect(idle).toMatchObject({
      running: false,
      runningCalls: [],
      pending: [],
      promptError: null,
      lastAgentError: null,
    })
    expect(idle.turnEnds.size).toBe(0)

    // Running → not running is a finished turn; the marker carries the clock.
    adapter.adapt({ running: true })
    now = 2000
    const done = adapter.adapt({ running: false, lastAgentError: 'boom' })
    expect(done.turnEnds.size).toBe(1)
    expect(done.turnEnds.get(0)).toBe(2000)
    expect(done.lastAgentError).toBe('boom')

    // Staying stopped is not another turn; a second run/stop cycle is.
    expect(adapter.adapt({ running: false }).turnEnds.size).toBe(1)
    adapter.adapt({ running: true })
    expect(adapter.adapt({ running: false, promptError: { op: 'send' } }).turnEnds.size).toBe(2)
  })
})

describe('wireMoodSource on the DSH 0.1.5+ list/binding surface', () => {
  const noTick = { schedule: () => () => {} }

  test('follows list.current to the bound face and derives moods from it', () => {
    const sessions = createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>(
      null,
      's-1',
      'binding',
    )
    const face = sessions.bind('s-1', { running: false })
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(sessions, machine, noTick)

    expect(machine.getSnapshot()).toBe('idle')
    face.set({ running: true })
    expect(machine.getSnapshot()).toBe('thinking')
    face.set({ running: false })
    // The running bit fell: a finished turn, celebrated.
    expect(machine.getSnapshot()).toBe('celebrating')
    face.set({ running: false, lastAgentError: 'rate limited' })
    dispose()
    // The face no longer drives — or holds — the machine.
    expect(face.listeners.size).toBe(0)
  })

  test('reads the list row while a session has no binding yet, then adopts the face', () => {
    const sessions = createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>(
      null,
      undefined,
      'binding',
    )
    sessions.list.set({ current: 's-2', byId: { 's-2': { running: true } } })
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(sessions, machine, noTick)

    // Not materialized: the row's running bit is all there is.
    expect(machine.getSnapshot()).toBe('thinking')

    // Binding arrives (the double bumps the list, as the shell does).
    const face = sessions.bind('s-2', { running: true, lastAgentError: null })
    expect(face.listeners.size).toBe(1)
    face.set({ running: false, lastAgentError: 'boom' })
    // Falling edge celebrates first; the pulse masks the sad base mood.
    expect(machine.getSnapshot()).toBe('celebrating')
    dispose()
  })

  test('a selection change drops the old face and null selection idles the pet', () => {
    const sessions = createMockSessions<ConversationSnapshotSlice, SessionSnapshotSlice>(
      null,
      's-1',
      'binding',
    )
    const first = sessions.bind('s-1', { running: true })
    const second = sessions.bind('s-2', { running: false, lastAgentError: 'failed' })
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(sessions, machine, noTick)
    expect(machine.getSnapshot()).toBe('thinking')

    sessions.setCurrent('s-2')
    expect(first.listeners.size).toBe(0)
    expect(second.listeners.size).toBe(1)
    expect(machine.getSnapshot()).toBe('sad')

    sessions.setCurrent(undefined)
    expect(second.listeners.size).toBe(0)
    expect(machine.getSnapshot()).toBe('idle')

    // Re-selecting establishes a fresh baseline: a running → stopped edge
    // witnessed after the swap still counts, an inherited one does not.
    sessions.setCurrent('s-1')
    expect(machine.getSnapshot()).toBe('thinking')
    first.set({ running: false })
    expect(machine.getSnapshot()).toBe('celebrating')
    dispose()
  })

  test('the client runtime built for a 0.1.5 shell drives the same path', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice, SessionSnapshotSlice>({
      sessionsShape: 'binding',
      currentSessionId: 's-1',
    })
    const face = runtime.sessions.bind('s-1', { running: true })
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(runtime.sessions, machine, noTick)
    expect(machine.getSnapshot()).toBe('thinking')
    face.set({ running: false })
    expect(machine.getSnapshot()).toBe('celebrating')
    dispose()
  })
})
