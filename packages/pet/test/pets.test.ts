/**
 * The built-in pet roster: ids unique, labels localized. Sprites belong to
 * the desktop app; this list must match its manifest's built-ins.
 */

import { describe, expect, test } from '@rstest/core'
import { PETS } from '../src/client/pets.js'

describe('PETS roster', () => {
  test('ids are unique and in picker order', () => {
    const ids = PETS.map((pet) => pet.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['deepseek-chan'])
  })

  test('every pet has both locale names', () => {
    for (const pet of PETS) {
      expect(pet.label.zh.length).toBeGreaterThan(0)
      expect(pet.label.en.length).toBeGreaterThan(0)
    }
  })
})
