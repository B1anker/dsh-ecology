/**
 * The built-in pet roster: every pet must render every mood as a standalone
 * SVG.
 */

import { describe, expect, test } from '@rstest/core'
import { PETS } from '../src/client/pets.js'
import { MOODS } from '../src/desktop.js'

describe('PETS roster', () => {
  test('ids are unique and in picker order', () => {
    const ids = PETS.map((pet) => pet.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['blob', 'cat', 'robot'])
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
