/**
 * The mood source: the wiring that replaced the page overlay as the state
 * machine's driver. Session snapshots flow into the machine, session swaps
 * re-subscribe without leaking, and the injected scheduler's tick advances
 * time-driven transitions. Driven through the testkit's client doubles, the
 * way the shell would drive it.
 */

import { describe, expect, test } from '@rstest/core'
import { createMockClientRuntime, createMockObservable } from '@seaveyon/dsh-plugin-testkit'
import type { ConversationSnapshotSlice } from '../src/client/host-types.js'
import { PetStateMachine } from '../src/client/mood.js'
import { MOOD_TICK_MS, wireMoodSource } from '../src/client/mood-source.js'

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
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
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
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    const machine = new PetStateMachine()
    const dispose = wireMoodSource(runtime.sessions, machine, { schedule: () => () => {} })
    const oldSession = runtime.sessions.currentProvideInfo.getSnapshot()!.hooks.session

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
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
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
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
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
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    const machine = new PetStateMachine()
    let cancelled = false
    const dispose = wireMoodSource(runtime.sessions, machine, {
      schedule: () => () => {
        cancelled = true
      },
    })
    const session = runtime.sessions.currentProvideInfo.getSnapshot()!.hooks.session

    dispose()

    expect(cancelled).toBe(true)
    expect(session.listeners.size).toBe(0)
    runtime.sessions.publish(snap({ running: true }))
    expect(machine.getSnapshot()).toBe('idle')
  })
})
