/**
 * The settings panel: the appearance picker is single-source. When the
 * desktop app answers /pets, its roster — built-ins included — is the whole
 * list (a pet can never appear twice), with RasterPet strip
 * previews off the bridge server and localized names for known ids. Only a
 * proven-offline desktop falls back to the built-in SVG roster plus a "not
 * connected" hint. Discovery retries quietly a couple of times while the
 * panel stays open.
 */

import { afterEach, beforeEach, describe, expect, test } from '@rstest/core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DesktopPetsStore } from '../src/client/desktop-pets.js'
import { PetSettingsStore } from '../src/client/settings.js'
import { PetSettingsPanel } from '../src/client/settings-panel.js'
import { MOODS } from '../src/desktop.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

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

/** A wire-format desktop pet with every mood covered. */
function desktopPetFixture(id: string) {
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

/** The desktop manifest's shape in production: built-ins plus imports. */
const DESKTOP_ROSTER = ['blob', 'cat', 'robot', 'ai-sleepy-silver-wolf']

function desktopPetsStore(ids: string[]): DesktopPetsStore {
  const fetchFn = () =>
    Promise.resolve(new Response(JSON.stringify({ pets: ids.map(desktopPetFixture) })))
  return new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
}

/** The desktop app not running, as a fetch. */
const offlineFetch = (() =>
  Promise.reject(new Error('connection refused'))) as unknown as typeof fetch

function mount(desktopPets?: DesktopPetsStore, retryDelayMs?: number) {
  const settings = new PetSettingsStore({})
  root = createRoot(container)
  act(() => {
    root?.render(
      createElement(PetSettingsPanel, {
        settings,
        ...(desktopPets !== undefined ? { desktopPets } : {}),
        ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
      }),
    )
  })
  return { settings }
}

function pickerButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[aria-pressed]'))
}

async function flushRefresh(store: DesktopPetsStore) {
  await act(async () => {
    await store.refresh()
  })
}

describe('fallback (desktop unreachable or not asked yet)', () => {
  test('lists the three built-in pets as SVG and selects one on click', () => {
    const { settings } = mount()
    const buttons = pickerButtons()
    expect(buttons).toHaveLength(3)
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true') // blob is default
    expect(container.querySelector('svg[data-pet-id="blob"]')).not.toBeNull()

    act(() => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settings.getSnapshot().petId).toBe('cat')
  })

  test('a proven-offline desktop adds the not-connected hint', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    mount(desktopPets)

    await flushRefresh(desktopPets)

    expect(pickerButtons()).toHaveLength(3)
    expect(container.querySelector('section')?.textContent).toContain('Desktop app not connected')
  })

  test('no fetch yet (unknown) shows built-ins without the hint', () => {
    mount() // no store at all: nothing is ever asked
    expect(container.querySelector('section')?.textContent).not.toContain('not connected')
    expect(pickerButtons()).toHaveLength(3)
  })
})

describe('single-source picker (desktop online)', () => {
  test('the /pets roster is the whole list — built-ins are not duplicated', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    mount(desktopPets)

    await flushRefresh(desktopPets)

    const buttons = pickerButtons()
    expect(buttons).toHaveLength(4)
    expect(buttons.map((b) => b.title)).toEqual(['Blob', 'Cat', 'Robot', 'Ai Sleepy Silver Wolf'])
    // Every preview is a raster strip off the bridge server, including the
    // built-ins — the SVG path only renders in the fallback.
    expect(container.querySelectorAll('[data-dsh-pet-raster]')).toHaveLength(4)
    expect(container.querySelectorAll('svg[data-pet-id]')).toHaveLength(0)
  })

  test('imported pets wear the badge; built-ins served by the desktop do not', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    mount(desktopPets)
    await flushRefresh(desktopPets)

    const buttons = pickerButtons()
    const wolf = buttons.find((b) => b.title === 'Ai Sleepy Silver Wolf')!
    expect(wolf.textContent).toContain('Imported')
    for (const title of ['Blob', 'Cat', 'Robot']) {
      expect(buttons.find((b) => b.title === title)!.textContent).not.toContain('Imported')
    }
  })

  test('selecting an imported pet persists its id and previews the pet mood', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    const { settings } = mount(desktopPets)
    await flushRefresh(desktopPets)

    const wolf = pickerButtons().find((b) => b.title === 'Ai Sleepy Silver Wolf')!
    act(() => {
      wolf.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settings.getSnapshot().petId).toBe('ai-sleepy-silver-wolf')
    expect(wolf.getAttribute('aria-pressed')).toBe('true')
    expect(wolf.querySelector('[data-dsh-pet-raster]')?.getAttribute('data-mood')).toBe('pet')
  })

  test('a selection made in the fallback stays selected once the desktop answers', async () => {
    let online = false
    const fetchFn = () =>
      online
        ? Promise.resolve(
            new Response(JSON.stringify({ pets: DESKTOP_ROSTER.map(desktopPetFixture) })),
          )
        : Promise.reject(new Error('connection refused'))
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    const { settings } = mount(desktopPets)

    // Fallback roster: pick the cat.
    act(() => {
      pickerButtons()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(settings.getSnapshot().petId).toBe('cat')

    // Desktop comes up; the same petId is selected in the desktop roster.
    online = true
    await flushRefresh(desktopPets)

    const cat = pickerButtons().find((b) => b.title === 'Cat')!
    expect(cat.getAttribute('aria-pressed')).toBe('true')
  })

  test('localized names follow the locale', async () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get: () => 'zh-CN',
    })
    try {
      const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
      mount(desktopPets)
      await flushRefresh(desktopPets)

      const buttons = pickerButtons()
      expect(buttons.map((b) => b.title)).toEqual([
        '果冻团',
        '猫猫',
        '机器人',
        'Ai Sleepy Silver Wolf',
      ])
      expect(buttons.find((b) => b.title === 'Ai Sleepy Silver Wolf')!.textContent).toContain(
        '导入',
      )
    } finally {
      if (original !== undefined) Object.defineProperty(Navigator.prototype, 'language', original)
    }
  })
})

describe('discovery retry', () => {
  test('a desktop that answers on the second attempt appears without reopening the panel', async () => {
    let calls = 0
    const fetchFn = () => {
      calls += 1
      return calls === 1
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(
            new Response(JSON.stringify({ pets: DESKTOP_ROSTER.map(desktopPetFixture) })),
          )
    }
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    mount(desktopPets, 10 /* ms between retries */)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(calls).toBe(2)
    expect(pickerButtons()).toHaveLength(4)
    expect(pickerButtons().some((b) => b.title === 'Ai Sleepy Silver Wolf')).toBe(true)
  })

  test('retries stop after the cap and the offline hint stays', async () => {
    let calls = 0
    const fetchFn = () => {
      calls += 1
      return Promise.reject(new Error('connection refused'))
    }
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    mount(desktopPets, 10)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    expect(calls).toBe(3) // initial attempt + 2 retries
    expect(pickerButtons()).toHaveLength(3)
    expect(container.querySelector('section')?.textContent).toContain('Desktop app not connected')
  })
})

describe('the rest of the panel', () => {
  test('the page-era controls are gone; the desktop hint stands in', () => {
    mount()
    // Only name (text) and companion (checkbox) survive.
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0)
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(1)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    expect(container.querySelector('section p')?.textContent).toContain('desktop app')
  })
})
