/**
 * RasterPet: the stepped-CSS sprite-strip renderer used by the settings
 * panel's imported-pet previews. The assertions are on the emitted style and
 * keyframes text — frames, duration, and steps are the whole contract.
 */

import { afterEach, beforeEach, describe, expect, test } from '@rstest/core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DesktopPet } from '../src/client/bridge.js'
import type { Mood } from '../src/client/mood.js'
import { RasterPet, rasterAnimationName } from '../src/client/raster-pet.js'
import { MOODS } from '../src/desktop.js'

;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root !== null) act(() => root?.unmount())
  root = null
  container.remove()
})

/** An imported pet with absolute strip URLs, as fetchDesktopPets delivers it. */
function rasterPetFixture(
  id = 'ai-sleepy-silver-wolf',
  frames = 6,
  frameDurationMs = 1100,
): DesktopPet {
  return {
    id,
    moods: Object.fromEntries(
      MOODS.map((mood) => [
        mood,
        { frames, frameDurationMs, url: `http://127.0.0.1:45731/sprites/${id}/${mood}.png` },
      ]),
    ) as Record<Mood, DesktopPet['moods'][Mood]>,
  }
}

function render(pet: DesktopPet, mood: Mood, size: number) {
  root = createRoot(container)
  act(() => {
    root?.render(createElement(RasterPet, { pet, mood, size }))
  })
}

describe('RasterPet', () => {
  test('emits the sprite-strip contract: sized background, stepped keyframes', () => {
    render(rasterPetFixture(), 'idle', 64)

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

  test('the mood picks the strip, and the strip URL switches on re-render', () => {
    render(rasterPetFixture(), 'working', 64)

    const el = container.querySelector('[data-dsh-pet-raster]') as HTMLElement
    expect(el.getAttribute('data-mood')).toBe('working')
    expect(el.style.backgroundImage).toContain('/sprites/ai-sleepy-silver-wolf/working.png')

    act(() => {
      root?.render(
        createElement(RasterPet, { pet: rasterPetFixture(), mood: 'sleeping', size: 64 }),
      )
    })
    expect(el.getAttribute('data-mood')).toBe('sleeping')
    expect(el.style.backgroundImage).toContain('/sprites/ai-sleepy-silver-wolf/sleeping.png')
  })

  test('the keyframes pixel offset scales with the display size', () => {
    render(rasterPetFixture('wolf', 4, 250), 'idle', 52)

    const css = container.querySelector('style')?.textContent ?? ''
    expect(css).toContain('background-position-x: -208px') // 4 × 52px
    expect(css).toContain('steps(4)')
    expect(css).toContain('1000ms') // 4 frames × 250ms
  })
})

describe('rasterAnimationName', () => {
  test('is a CSS-identifier-safe function of pet, mood, frames, and size', () => {
    expect(rasterAnimationName('ai-sleepy-silver-wolf', 'idle', 6, 64)).toBe(
      'dsh-pet-raster-ai-sleepy-silver-wolf-idle-6f-640',
    )
    // Ids with characters CSS identifiers reject are sanitized.
    expect(rasterAnimationName('my pet.v2', 'pet', 1, 52)).toBe(
      'dsh-pet-raster-my_pet_v2-pet-1f-520',
    )
  })
})
