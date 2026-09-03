/**
 * Mood derivation and the state machine, covered branch by branch.
 *
 * The state machine tests run on an injected fake clock: time only moves when
 * the test moves it, so pulse expiry and sleep onset are exact assertions
 * rather than races.
 */

import { describe, expect, test } from '@rstest/core'
import type { ConversationSnapshotSlice } from '../src/client/host-types.js'
import {
  CELEBRATE_MS,
  deriveMood,
  PET_MS,
  PetStateMachine,
  SLEEP_AFTER_MS,
} from '../src/client/mood.js'

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

describe('deriveMood', () => {
  test('pending input outranks a running agent: the user must act', () => {
    expect(deriveMood(snap({ running: true, pending: [{}] }))).toBe('waiting')
  })

  test('running with live tool calls is working', () => {
    expect(deriveMood(snap({ running: true, runningCalls: [{ name: 'bash' }] }))).toBe('working')
  })

  test('running without tool calls is thinking', () => {
    expect(deriveMood(snap({ running: true }))).toBe('thinking')
  })

  test('a stopped agent with an error is sad', () => {
    expect(deriveMood(snap({ promptError: new Error('x') }))).toBe('sad')
    expect(deriveMood(snap({ lastAgentError: 'boom' }))).toBe('sad')
  })

  test('errors do not interrupt a still-running agent', () => {
    expect(deriveMood(snap({ running: true, lastAgentError: 'boom' }))).toBe('thinking')
    expect(
      deriveMood(snap({ running: true, runningCalls: [{ name: 'bash' }], promptError: {} })),
    ).toBe('working')
  })

  test('a quiet stopped agent idles', () => {
    expect(deriveMood(snap())).toBe('idle')
  })
})

/** A state machine on a fake clock: time moves only when `advance` says so. */
function rig(start = 0) {
  let now = start
  const machine = new PetStateMachine({ now: () => now })
  return { machine, advance: (ms: number) => (now += ms) }
}

describe('PetStateMachine', () => {
  test('a finished turn fires a celebration pulse, then falls back', () => {
    const { machine, advance } = rig()
    machine.update(snap({ running: true }))
    machine.update(snap({ turnEnds: new Map([[1, 1]]) }))
    expect(machine.getSnapshot()).toBe('celebrating')

    advance(CELEBRATE_MS - 1)
    machine.tick()
    expect(machine.getSnapshot()).toBe('celebrating')

    advance(1)
    machine.tick()
    expect(machine.getSnapshot()).toBe('idle')
  })

  test('turn ends mid-run do not celebrate until the agent stops', () => {
    const { machine } = rig()
    machine.update(snap({ running: true, turnEnds: new Map([[1, 1]]) }))
    expect(machine.getSnapshot()).toBe('thinking')
  })

  test('a swapped-in session resyncs the turn baseline instead of celebrating', () => {
    const { machine } = rig()
    machine.update(null)
    machine.update(
      snap({
        turnEnds: new Map([
          [1, 1],
          [2, 2],
          [3, 3],
        ]),
      }),
    )
    expect(machine.getSnapshot()).toBe('idle')
  })

  test('petting fires an affection pulse that overrides the base mood', () => {
    const { machine, advance } = rig()
    machine.update(snap({ lastAgentError: 'boom' }))
    expect(machine.getSnapshot()).toBe('sad')

    machine.pet()
    expect(machine.getSnapshot()).toBe('pet')

    advance(PET_MS)
    machine.tick()
    expect(machine.getSnapshot()).toBe('sad')
  })

  test('five unchanged idle minutes put the pet to sleep', () => {
    const { machine, advance } = rig()
    machine.update(snap())
    advance(SLEEP_AFTER_MS - 1)
    machine.tick()
    expect(machine.getSnapshot()).toBe('idle')

    advance(1)
    machine.tick()
    expect(machine.getSnapshot()).toBe('sleeping')
  })

  test('activity wakes the pet and restarts the sleep clock', () => {
    const { machine, advance } = rig()
    machine.update(snap())
    advance(SLEEP_AFTER_MS)
    machine.tick()
    expect(machine.getSnapshot()).toBe('sleeping')

    machine.update(snap({ running: true }))
    expect(machine.getSnapshot()).toBe('thinking')

    machine.update(snap())
    advance(SLEEP_AFTER_MS - 1)
    machine.tick()
    expect(machine.getSnapshot()).toBe('idle')
  })

  test('a null snapshot drops the pet to idle and clears turn bookkeeping', () => {
    const { machine } = rig()
    machine.update(snap({ running: true }))
    machine.update(snap({ turnEnds: new Map([[1, 1]]) }))
    expect(machine.getSnapshot()).toBe('celebrating')
    machine.update(null)
    expect(machine.getSnapshot()).toBe('idle')
  })

  test('subscribers are notified on mood changes only', () => {
    const { machine } = rig()
    let calls = 0
    const unsubscribe = machine.subscribe(() => calls++)
    machine.update(snap())
    expect(calls).toBe(0)
    machine.update(snap({ running: true }))
    expect(calls).toBe(1)
    unsubscribe()
    machine.update(snap())
    expect(calls).toBe(1)
  })
})
