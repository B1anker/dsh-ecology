/**
 * The built-in pet roster: every pet must render every mood as a standalone
 * SVG, and DeepSeek 酱 joins with her bilingual name and whale-maid motifs.
 */

import { describe, expect, test } from '@rstest/core'
import { PET_STYLE_CSS, PETS } from '../src/client/pets.js'
import { MOODS } from '../src/desktop.js'

describe('PETS roster', () => {
  test('ids are unique and deepseek-chan is in picker order after robot', () => {
    const ids = PETS.map((pet) => pet.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['blob', 'cat', 'robot', 'deepseek-chan'])
  })

  test('every pet renders every mood as a standalone 64×64 svg', () => {
    for (const pet of PETS) {
      for (const mood of MOODS) {
        const svg = pet.svg(mood)
        expect(svg).toContain(`data-pet-id="${pet.id}"`)
        expect(svg).toContain(`data-mood="${mood}"`)
        expect(svg).toContain('viewBox="0 0 64 64"')
        expect(svg).toContain('data-mood-parts="eyes"')
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg.endsWith('</svg>')).toBe(true)
      }
    }
  })

  test('every pet has both locale names', () => {
    for (const pet of PETS) {
      expect(pet.label.zh.length).toBeGreaterThan(0)
      expect(pet.label.en.length).toBeGreaterThan(0)
    }
  })
})

describe('deepseek-chan', () => {
  const pet = PETS.find((p) => p.id === 'deepseek-chan')!

  test('is named DeepSeek 酱 / DeepSeek-chan', () => {
    expect(pet.label).toEqual({ zh: 'DeepSeek 酱', en: 'DeepSeek-chan' })
  })

  test('wears the whale-maid uniform in every mood', () => {
    for (const mood of MOODS) {
      const svg = pet.svg(mood)
      expect(svg).toContain('dsh-pet-dsc-hair') // deep-blue hair gradient
      expect(svg).toContain('dsh-pet-dsc-ears') // drooping whale fin ears
      expect(svg).toContain('dsh-pet-dsc-headdress') // frilled maid headdress
      expect(svg).toContain('dsh-pet-dsc-apron') // apron with the whale crest
      expect(svg).toContain('dsh-pet-dsc-tail') // whale tail behind the skirt
    }
  })

  test('tosses gold coins only while celebrating', () => {
    expect(pet.svg('celebrating')).toContain('dsh-pet-dsc-coins')
    expect(pet.svg('celebrating')).toContain('#f5c542')
    for (const mood of MOODS) {
      if (mood !== 'celebrating') expect(pet.svg(mood)).not.toContain('dsh-pet-dsc-coins')
    }
  })

  test('hugs her rice bowl only when petted', () => {
    expect(pet.svg('pet')).toContain('dsh-pet-dsc-bowl')
    for (const mood of MOODS) {
      if (mood !== 'pet') expect(pet.svg(mood)).not.toContain('dsh-pet-dsc-bowl')
    }
  })

  test('the whale tail wags on its own keyframes while celebrating', () => {
    expect(PET_STYLE_CSS).toContain('@keyframes dsh-pet-tail-wag')
    expect(PET_STYLE_CSS).toContain('.dsh-pet-mood-celebrating .dsh-pet-dsc-tail')
    // The tail carries dsh-pet-body too, so the bake script's per-cell
    // animation-delay rule reaches it.
    expect(pet.svg('celebrating')).toContain('class="dsh-pet-body dsh-pet-dsc-tail"')
  })

  test('closed-eye moods skip the blink class; open-eye moods keep it', () => {
    expect(pet.svg('idle')).toContain('dsh-pet-blink')
    expect(pet.svg('celebrating')).not.toContain('class="dsh-pet-blink"')
    expect(pet.svg('sleeping')).toContain('dsh-pet-zzz')
  })
})
