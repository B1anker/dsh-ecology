/**
 * The settings panel: the appearance picker is single-source. When the
 * desktop app answers /pets, its roster — built-ins included — is the whole
 * list (a pet can never appear twice), with RasterPet strip
 * previews off the bridge server and localized names for known ids. Until
 * the desktop answers (unknown or proven offline), the picker renders
 * nothing; offline adds a "not connected" hint. Discovery retries quietly a
 * couple of times while the panel stays open.
 */

import { afterEach, beforeEach, describe, expect, test } from '@rstest/core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DesktopPetsStore } from '../src/client/desktop-pets.js'
import { DESKTOP_DOWNLOAD_URL, type LaunchRequestResult } from '../src/client/launch.js'
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
const DESKTOP_ROSTER = ['deepseek-chan', 'ai-sleepy-silver-wolf']

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

describe('picker hidden until the desktop answers', () => {
  test('no store at all: no picker, no hint', () => {
    mount() // no store at all: nothing is ever asked
    expect(pickerButtons()).toHaveLength(0)
    expect(container.querySelector('section')?.textContent).not.toContain('not connected')
  })

  test('a proven-offline desktop shows only the not-connected hint', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    mount(desktopPets)

    await flushRefresh(desktopPets)

    expect(pickerButtons()).toHaveLength(0)
    expect(container.querySelector('section')?.textContent).toContain('Desktop app not connected')
  })
})

describe('single-source picker (desktop online)', () => {
  test('the /pets roster is the whole list — built-ins are not duplicated', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    mount(desktopPets)

    await flushRefresh(desktopPets)

    const buttons = pickerButtons()
    expect(buttons).toHaveLength(2)
    expect(buttons.map((b) => b.title)).toEqual(['DeepSeek-chan', 'Ai Sleepy Silver Wolf'])
    // Every preview is a raster strip off the bridge server, including the
    // built-in — the page no longer ships an SVG stand-in path at all.
    expect(container.querySelectorAll('[data-dsh-pet-raster]')).toHaveLength(2)
    expect(container.querySelectorAll('svg[data-pet-id]')).toHaveLength(0)
  })

  test('imported pets wear the badge; built-ins served by the desktop do not', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    mount(desktopPets)
    await flushRefresh(desktopPets)

    const buttons = pickerButtons()
    const wolf = buttons.find((b) => b.title === 'Ai Sleepy Silver Wolf')!
    expect(wolf.textContent).toContain('Imported')
    expect(buttons.find((b) => b.title === 'DeepSeek-chan')!.textContent).not.toContain('Imported')
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

  test('a stored petId stays selected once the desktop answers', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    const { settings } = mount(desktopPets)

    // The petId persisted from an earlier session (the desktop app restores
    // the same one from its own state file).
    act(() => {
      settings.update({ petId: 'deepseek-chan' })
    })

    await flushRefresh(desktopPets)

    const chan = pickerButtons().find((b) => b.title === 'DeepSeek-chan')!
    expect(chan.getAttribute('aria-pressed')).toBe('true')
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
      expect(buttons.map((b) => b.title)).toEqual(['DeepSeek 酱', 'Ai Sleepy Silver Wolf'])
      expect(buttons.find((b) => b.title === 'Ai Sleepy Silver Wolf')!.textContent).toContain(
        '导入',
      )
      expect(buttons.find((b) => b.title === 'DeepSeek 酱')!.textContent).not.toContain('导入')
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
    expect(pickerButtons()).toHaveLength(2)
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
    expect(pickerButtons()).toHaveLength(0)
    expect(container.querySelector('section')?.textContent).toContain('Desktop app not connected')
  })
})

describe('the rest of the panel', () => {
  test('the page-era controls are gone; the desktop hint stands in', () => {
    mount()
    // Only the name input survives; the companion is a summon button now.
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0)
    expect(container.querySelectorAll('input[type="text"]')).toHaveLength(1)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.querySelector('section p')?.textContent).toContain('desktop app')
  })
})

describe('desktop launch (loopback page, offline companion)', () => {
  /** Mount with the launcher seams injected: fast nudges, stubbed request. */
  function mountWithLaunch(
    desktopPets: DesktopPetsStore,
    requestLaunch: () => Promise<LaunchRequestResult>,
  ) {
    const settings = new PetSettingsStore({})
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(PetSettingsPanel, {
          settings,
          desktopPets,
          requestLaunch,
          launchRefreshDelaysMs: [5, 10, 15],
          retryDelayMs: 10,
        }),
      )
    })
    return { settings }
  }

  /** Let the mount-time discovery attempts settle into the offline state. */
  async function settleOffline() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
  }

  function launchButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Launch desktop app',
    )
  }

  test('the offline companion state offers a launch button', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    mountWithLaunch(desktopPets, () => Promise.resolve('unavailable'))
    await settleOffline()

    expect(desktopPets.getSnapshot().status).toBe('offline')
    expect(launchButton()).toBeDefined()
  })

  test('a successful launch nudges discovery and the desktop roster comes up', async () => {
    let online = false
    const fetchFn = () =>
      online
        ? Promise.resolve(
            new Response(JSON.stringify({ pets: DESKTOP_ROSTER.map(desktopPetFixture) })),
          )
        : Promise.reject(new Error('connection refused'))
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    let launchCalls = 0
    mountWithLaunch(desktopPets, () => {
      launchCalls += 1
      online = true // the launched app binds the bridge port a moment later
      return Promise.resolve('launched')
    })
    await settleOffline()

    await act(async () => {
      launchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(launchCalls).toBe(1)
    expect(pickerButtons()).toHaveLength(DESKTOP_ROSTER.length)
  })

  test('a not-installed answer points at the download page', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    mountWithLaunch(desktopPets, () => Promise.resolve('not-installed'))
    await settleOffline()

    await act(async () => {
      launchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('section')?.textContent).toContain(
      'not installed on this machine',
    )
    const link = container.querySelector(`a[href="${DESKTOP_DOWNLOAD_URL}"]`)
    expect(link).not.toBeNull()
  })

  test('the summon button turns the companion on and fires one launch attempt', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    let launchCalls = 0
    const { settings } = mountWithLaunch(desktopPets, () => {
      launchCalls += 1
      return Promise.resolve('unavailable')
    })
    await settleOffline()

    // Companion off: the summon button is still offered — clicking it is
    // the "make it work" gesture, enabling the bridge as it launches.
    act(() => settings.update({ companionEnabled: false }))
    expect(launchButton()).toBeDefined()
    await act(async () => {
      launchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settings.getSnapshot().companionEnabled).toBe(true)
    expect(launchCalls).toBe(1)
  })

  test('a failed launch says so', async () => {
    const desktopPets = new DesktopPetsStore({ fetchFn: offlineFetch })
    let launchCalls = 0
    mountWithLaunch(desktopPets, () => {
      launchCalls += 1
      return Promise.resolve('unavailable')
    })
    await settleOffline()

    await act(async () => {
      launchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(launchCalls).toBe(1)
    expect(container.querySelector('section')?.textContent).toContain('Launch failed')
  })

  test('quitting after a successful launch re-arms the launch button', async () => {
    let online = false
    const fetchFn = () =>
      online
        ? Promise.resolve(
            new Response(JSON.stringify({ pets: DESKTOP_ROSTER.map(desktopPetFixture) })),
          )
        : Promise.reject(new Error('connection refused'))
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    let launchCalls = 0
    mountWithLaunch(desktopPets, () => {
      launchCalls += 1
      online = true
      return Promise.resolve('launched')
    })
    await settleOffline()

    // Launch and let the desktop answer: the connected readout takes over.
    await act(async () => {
      launchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(launchButton()).toBeUndefined()

    // The user quits the app: the button comes back — armed, not stuck on
    // "starting" — and launches again.
    online = false
    await act(async () => {
      await desktopPets.refresh()
    })
    const rearmed = launchButton()
    expect(rearmed).toBeDefined()
    expect(rearmed?.disabled).toBe(false)
    await act(async () => {
      rearmed?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(launchCalls).toBe(2)
  })

  test('a connected desktop replaces the button with a readout', async () => {
    const desktopPets = desktopPetsStore(DESKTOP_ROSTER)
    mountWithLaunch(desktopPets, () => Promise.resolve('launched'))
    await flushRefresh(desktopPets)

    expect(launchButton()).toBeUndefined()
    expect(container.querySelector('section')?.textContent).toContain('Desktop pet connected')
  })

  test('quitting the desktop app flips the panel back to the summon state', async () => {
    let running = true
    const fetchFn = () =>
      running
        ? Promise.resolve(
            new Response(JSON.stringify({ pets: DESKTOP_ROSTER.map(desktopPetFixture) })),
          )
        : Promise.reject(new Error('connection refused'))
    const desktopPets = new DesktopPetsStore({ fetchFn: fetchFn as unknown as typeof fetch })
    const settings = new PetSettingsStore({})
    root = createRoot(container)
    act(() => {
      root?.render(
        createElement(PetSettingsPanel, {
          settings,
          desktopPets,
          requestLaunch: () => Promise.resolve('launched' as const),
          retryDelayMs: 10,
          pollIntervalMs: 10,
        }),
      )
    })
    await flushRefresh(desktopPets)
    expect(container.querySelector('section')?.textContent).toContain('Desktop pet connected')

    // The user quits the app; the next poll tick must notice.
    running = false
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(desktopPets.getSnapshot().status).toBe('offline')
    expect(container.querySelector('section')?.textContent).not.toContain('Desktop pet connected')
    expect(launchButton()).toBeDefined()
  })
})
