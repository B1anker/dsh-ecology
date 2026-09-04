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
import { DesktopPetsStore } from '../src/client/desktop-pets.js'
import type { ConversationSnapshotSlice } from '../src/client/host-types.js'
import { PetStateMachine } from '../src/client/mood.js'
import { PetOverlay, RasterPet } from '../src/client/overlay.js'
import { PetSettingsStore } from '../src/client/settings.js'
import { MOODS } from '../src/desktop.js'

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

/** A wire-format imported pet: 6 frames at 1100ms each, for every mood. */
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

/** A desktop-pets store whose discovery fetch succeeds (or not) as asked. */
function desktopPetsStore(online: boolean, ids = ['ai-sleepy-silver-wolf']): DesktopPetsStore {
  const fetchFn = () =>
    online
      ? Promise.resolve(new Response(JSON.stringify({ pets: ids.map(desktopPetFixture) })))
      : Promise.reject(new Error('connection refused'))
  return new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
}

/** Mount the overlay without the testkit runtime, with an imported-pets store. */
function mountWithDesktopPets(desktopPets: DesktopPetsStore) {
  const settings = new PetSettingsStore({})
  const machine = new PetStateMachine()
  root = createRoot(container)
  act(() => {
    root?.render(createElement(PetOverlay, { settings, machine, desktopPets }))
  })
  return { settings, machine }
}

describe('RasterPet', () => {
  test('emits the sprite-strip contract: sized background, stepped keyframes', () => {
    const pet = {
      id: 'ai-sleepy-silver-wolf',
      moods: Object.fromEntries(
        MOODS.map((mood) => [
          mood,
          {
            frames: 6,
            frameDurationMs: 1100,
            url: `http://127.0.0.1:45731/sprites/ai-sleepy-silver-wolf/${mood}.png`,
          },
        ]),
      ),
    } as never
    root = createRoot(container)
    act(() => {
      root?.render(createElement(RasterPet, { pet, mood: 'idle', size: 64 }))
    })

    const el = container.querySelector('[data-dsh-pet-raster]') as HTMLElement
    expect(el.getAttribute('data-pet-id')).toBe('ai-sleepy-silver-wolf')
    expect(el.getAttribute('data-mood')).toBe('idle')
    expect(el.style.backgroundImage).toContain(
      'http://127.0.0.1:45731/sprites/ai-sleepy-silver-wolf/idle.png',
    )
    expect(el.style.backgroundSize).toBe('600% 100%')
    expect(el.style.backgroundRepeat).toBe('no-repeat')

    const css = container.querySelector('style')?.textContent ?? ''
    expect(css).toContain('steps(6)')
    expect(css).toContain('6600ms') // 6 frames × 1100ms
    expect(css).toContain('background-position-x: -384px') // 6 × 64px strip width
    expect(css).toContain('prefers-reduced-motion: no-preference')
  })
})

describe('imported desktop pets', () => {
  test('a selected imported pet renders as a raster strip once discovered', async () => {
    const desktopPets = desktopPetsStore(true)
    const { settings } = mountWithDesktopPets(desktopPets)
    act(() => settings.update({ petId: 'ai-sleepy-silver-wolf' }))

    // Before discovery completes the built-in fallback is on screen.
    expect(container.querySelector('svg[data-pet-id="blob"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-pet-raster]')).toBeNull()

    await act(async () => {
      await desktopPets.refresh()
    })

    expect(container.querySelector('svg[data-pet-id]')).toBeNull()
    const raster = container.querySelector('[data-dsh-pet-raster]') as HTMLElement
    expect(raster.getAttribute('data-pet-id')).toBe('ai-sleepy-silver-wolf')
    expect(raster.style.backgroundImage).toContain('/sprites/ai-sleepy-silver-wolf/idle.png')
  })

  test('the raster strip follows the mood machine', async () => {
    const runtime = createMockClientRuntime<ConversationSnapshotSlice>()
    const desktopPets = desktopPetsStore(true)
    const settings = new PetSettingsStore({ binder: runtime.settingsScope })
    const machine = new PetStateMachine()
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(PetOverlay, { settings, machine, sessions: runtime.sessions, desktopPets }),
      )
    })
    act(() => settings.update({ petId: 'ai-sleepy-silver-wolf' }))
    await act(async () => {
      await desktopPets.refresh()
    })

    act(() => runtime.sessions.publish(snap({ running: true, runningCalls: [{ name: 'bash' }] })))

    const raster = container.querySelector('[data-dsh-pet-raster]') as HTMLElement
    expect(raster.getAttribute('data-mood')).toBe('working')
    expect(raster.style.backgroundImage).toContain('/sprites/ai-sleepy-silver-wolf/working.png')
  })

  test('an imported petId with the desktop app offline falls back to blob', async () => {
    const desktopPets = desktopPetsStore(false)
    const { settings } = mountWithDesktopPets(desktopPets)
    act(() => settings.update({ petId: 'ai-sleepy-silver-wolf' }))

    await act(async () => {
      await desktopPets.refresh()
    })

    expect(container.querySelector('[data-dsh-pet-raster]')).toBeNull()
    expect(container.querySelector('svg[data-pet-id="blob"]')).not.toBeNull()
  })

  test('without a store no fetch happens and built-ins render as before', () => {
    const settings = new PetSettingsStore({})
    const machine = new PetStateMachine()
    root = createRoot(container)
    act(() => {
      root?.render(createElement(PetOverlay, { settings, machine }))
    })
    expect(container.querySelector('svg[data-pet-id="blob"]')).not.toBeNull()
  })
})
