/**
 * The overlay, mounted for real: jsdom + react-dom, driven through the
 * client doubles from the testkit the way the shell would drive it.
 *
 * React 19's `act` requires the environment flag below; every render and
 * every observable publish is wrapped so effects (the snapshot → state
 * machine feed) flush before assertions run.
 */

import { afterEach, beforeEach, describe, expect, test } from '@rstest/core'
import { createMockClientRuntime, createMockObservable } from '@seaveyon/dsh-plugin-testkit'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationSnapshotSlice } from '../src/client/host-types.js'
import { PetStateMachine } from '../src/client/mood.js'
import { PetOverlay } from '../src/client/overlay.js'
import { PetSettingsStore } from '../src/client/settings.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

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

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root !== null) act(() => root?.unmount())
  root = null
  container.remove()
})

function mount(runtime: ReturnType<typeof createMockClientRuntime<ConversationSnapshotSlice>>) {
  const settings = new PetSettingsStore({ binder: runtime.settingsScope })
  const machine = new PetStateMachine()
  root = createRoot(container)
  act(() => {
    root?.render(createElement(PetOverlay, { settings, machine, sessions: runtime.sessions }))
  })
  return { settings, machine }
}

function moodOf(): string | null {
  return container.querySelector('svg[data-pet-id]')?.getAttribute('data-mood') ?? null
}

/** A click in overlay terms: pointerdown + pointerup without travel. */
function click(target: Element) {
  for (const type of ['pointerdown', 'pointerup']) {
    act(() => {
      target.dispatchEvent(new Event(type, { bubbles: true }))
    })
  }
}

describe('PetOverlay', () => {
  test('renders the configured pet, idle by default', () => {
    mount(createMockClientRuntime<ConversationSnapshotSlice>())
    expect(container.querySelector('svg[data-pet-id="blob"]')).not.toBeNull()
    expect(moodOf()).toBe('idle')
  })

  test('a running tool call surfaces its name in the bubble', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    mount(runtime)
    act(() => runtime.sessions.publish(snap({ running: true, runningCalls: [{ name: 'bash' }] })))
    expect(moodOf()).toBe('working')
    expect(container.querySelector('.dsh-pet-bubble')?.textContent).toBe('bash')
  })

  test('pending input shows the waiting hint instead of a tool name', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    mount(runtime)
    act(() => runtime.sessions.publish(snap({ running: true, pending: [{}] })))
    expect(moodOf()).toBe('waiting')
    expect(container.querySelector('.dsh-pet-bubble')?.textContent).not.toBeNull()
  })

  test('clicking the pet fires the affection pulse with a heart', () => {
    const { machine } = mount(createMockClientRuntime<ConversationSnapshotSlice>())
    const overlay = container.querySelector('[data-dsh-pet-overlay]')!
    click(overlay)
    expect(machine.getSnapshot()).toBe('pet')
    expect(moodOf()).toBe('pet')
    expect(container.querySelector('.dsh-pet-heart')).not.toBeNull()
  })

  test('double-click hides the pet behind a paw button that restores it', () => {
    mount(createMockClientRuntime<ConversationSnapshotSlice>())
    const overlay = container.querySelector('[data-dsh-pet-overlay]')!
    act(() => {
      overlay.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('[data-dsh-pet-overlay]')).toBeNull()
    const paw = container.querySelector('button')
    expect(paw).not.toBeNull()
    act(() => {
      paw!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-dsh-pet-overlay]')).not.toBeNull()
  })

  test('keyboard: Enter pets the pet', () => {
    const { machine } = mount(createMockClientRuntime<ConversationSnapshotSlice>())
    const overlay = container.querySelector('[data-dsh-pet-overlay]')!
    act(() => {
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(machine.getSnapshot()).toBe('pet')
  })

  test('a session swap resubscribes without leaking the old session', () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    mount(runtime)
    const oldSession = runtime.sessions.currentProvideInfo.getSnapshot()!.hooks.session

    const newSession = createMockObservable<ConversationSnapshotSlice | null>(null)
    act(() => runtime.sessions.select(null))
    expect(moodOf()).toBe('idle')
    act(() => runtime.sessions.select({ hooks: { session: newSession } }))

    act(() => newSession.set(snap({ running: true, runningCalls: [{ name: 'read' }] })))
    expect(container.querySelector('.dsh-pet-bubble')?.textContent).toBe('read')
    // The old session observable no longer drives — and no longer holds — us.
    expect(oldSession.listeners.size).toBe(0)
    expect(newSession.listeners.size).toBe(1)
  })

  test('without a sessions service the pet renders and stays idle', () => {
    const settings = new PetSettingsStore({})
    const machine = new PetStateMachine()
    root = createRoot(container)
    act(() => {
      root?.render(createElement(PetOverlay, { settings, machine }))
    })
    expect(moodOf()).toBe('idle')
  })

  test('visible: false renders nothing', () => {
    const { settings } = mount(createMockClientRuntime<ConversationSnapshotSlice>())
    act(() => settings.update({ visible: false }))
    expect(container.querySelector('[data-dsh-pet-overlay]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })
})
