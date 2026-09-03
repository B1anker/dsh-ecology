/**
 * The settings panel: the appearance picker merges the built-in SVG roster
 * with whatever imported pets the desktop app advertises, and selecting any of
 * them writes straight into the settings store.
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

/** A wire-format imported pet with every mood covered. */
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

function desktopPetsStore(ids: string[]): DesktopPetsStore {
  const fetchFn = () =>
    Promise.resolve(new Response(JSON.stringify({ pets: ids.map(desktopPetFixture) })))
  return new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
}

/** The desktop app not running, as a fetch. */
const offlineFetch = (() =>
  Promise.reject(new Error('connection refused'))) as unknown as typeof fetch

function mount(desktopPets?: DesktopPetsStore) {
  const settings = new PetSettingsStore({})
  root = createRoot(container)
  act(() => {
    root?.render(
      createElement(PetSettingsPanel, {
        settings,
        ...(desktopPets !== undefined ? { desktopPets } : {}),
      }),
    )
  })
  return { settings }
}

function pickerButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[aria-pressed]'))
}

describe('PetSettingsPanel', () => {
  test('lists the four built-in pets and selects one on click', () => {
    const { settings } = mount()
    const buttons = pickerButtons()
    expect(buttons).toHaveLength(4)
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true') // blob is default

    act(() => {
      buttons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settings.getSnapshot().petId).toBe('cat')
  })

  test('imported desktop pets join the picker with a badge and a pretty title', async () => {
    const desktopPets = desktopPetsStore(['ai-sleepy-silver-wolf'])
    mount(desktopPets)

    await act(async () => {
      await desktopPets.refresh()
    })

    const buttons = pickerButtons()
    expect(buttons).toHaveLength(5)
    const imported = buttons[4]!
    expect(imported.title).toBe('Ai Sleepy Silver Wolf')
    expect(imported.textContent).toContain('Desktop') // the badge, en locale
    expect(imported.querySelector('[data-dsh-pet-raster]')).not.toBeNull()
  })

  test('selecting an imported pet persists its id and previews the pet mood', async () => {
    const desktopPets = desktopPetsStore(['ai-sleepy-silver-wolf'])
    const { settings } = mount(desktopPets)
    await act(async () => {
      await desktopPets.refresh()
    })

    act(() => {
      pickerButtons()[4]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settings.getSnapshot().petId).toBe('ai-sleepy-silver-wolf')
    const imported = pickerButtons()[4]!
    expect(imported.getAttribute('aria-pressed')).toBe('true')
    expect(imported.querySelector('[data-dsh-pet-raster]')?.getAttribute('data-mood')).toBe('pet')
  })

  test('a failed discovery leaves only the built-in roster', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    mount(desktopPets)

    await act(async () => {
      await desktopPets.refresh()
    })

    expect(pickerButtons()).toHaveLength(4)
    expect(container.querySelector('[data-dsh-pet-raster]')).toBeNull()
  })
})
