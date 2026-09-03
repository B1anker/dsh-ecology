/**
 * Pure-logic tests for the Codex pet importer: pet.json parsing and
 * validation (mirroring openai/codex model.rs), the default-animation table,
 * mood mapping, frame-grid geometry, and strip thinning. Run with:
 *   bun test packages/pet-desktop/test
 */

import { describe, expect, test } from 'bun:test'

import {
  assertGridCoversSheet,
  buildStripPlan,
  capStripFrames,
  DEFAULT_FRAME,
  DEFAULT_FRAME_V2,
  fitFrame,
  isValidPetId,
  MAX_STRIP_FRAMES,
  MOOD_SOURCES,
  MOODS,
  parseCodexPet,
  resolveAnimations,
  SLEEP_DURATION_FACTOR,
  spriteRect,
} from '../scripts/lib/codex-pet.mjs'

describe('parseCodexPet', () => {
  test('minimal document gets the Codex defaults', () => {
    const pet = parseCodexPet('{}')
    expect(pet.frame).toEqual(DEFAULT_FRAME)
    expect(pet.spriteVersion).toBe(1)
    expect(pet.spritesheetPath).toBe('spritesheet.webp')
    expect(pet.animations).toEqual({})
    expect(pet.customAnimations).toBe(false)
    expect(pet.id).toBeNull()
  })

  test('spriteVersionNumber 2 selects the 11-row desktop layout', () => {
    const pet = parseCodexPet('{"spriteVersionNumber":2}')
    expect(pet.spriteVersion).toBe(2)
    expect(pet.frame).toEqual(DEFAULT_FRAME_V2)
    // An explicit frame still wins over the version-derived default.
    const explicit = parseCodexPet(
      '{"spriteVersionNumber":2,"frame":{"width":96,"height":96,"columns":4,"rows":4}}',
    )
    expect(explicit.frame).toEqual({ width: 96, height: 96, columns: 4, rows: 4 })
  })

  test('unknown sprite versions are rejected', () => {
    expect(() => parseCodexPet('{"spriteVersionNumber":3}')).toThrow(/spriteVersionNumber/)
    expect(() => parseCodexPet('{"spriteVersionNumber":"2"}')).toThrow(/spriteVersionNumber/)
  })

  test('full document parses all fields', () => {
    const pet = parseCodexPet(
      JSON.stringify({
        id: 'chefito',
        displayName: 'Chefito',
        description: 'A tiny chef',
        spritesheetPath: 'sheet.png',
        frame: { width: 96, height: 96, columns: 4, rows: 4 },
        animations: {
          idle: { frames: [0, 1], fps: 6 },
          custom: { frames: [3, 2, 1] },
        },
      }),
    )
    expect(pet.id).toBe('chefito')
    expect(pet.displayName).toBe('Chefito')
    expect(pet.frame).toEqual({ width: 96, height: 96, columns: 4, rows: 4 })
    expect(pet.animations.idle).toEqual({ frames: [0, 1], fps: 6 })
    expect(pet.animations.custom.fps).toBe(8) // codex default fps
    expect(pet.customAnimations).toBe(true)
  })

  test('rejects what Codex rejects', () => {
    expect(() => parseCodexPet('not json')).toThrow(/invalid JSON/)
    expect(() => parseCodexPet('[1]')).toThrow(/top level/)
    expect(() => parseCodexPet('{"frame":{"width":0,"height":1,"columns":1,"rows":1}}')).toThrow(
      /frame\.width/,
    )
    expect(() => parseCodexPet('{"frame":{"width":32,"height":32,"columns":32,"rows":9}}')).toThrow(
      /exceeds 256/,
    )
    expect(() => parseCodexPet('{"animations":{"idle":{"frames":[]}}}')).toThrow(/at least one/)
    expect(() => parseCodexPet('{"animations":{"idle":{"frames":[-1]}}}')).toThrow(/sprite index/)
    expect(() => parseCodexPet('{"animations":{"idle":{"frames":[0],"fps":0}}}')).toThrow(/fps/)
    expect(() => parseCodexPet('{"animations":{"idle":{"frames":[0],"fps":61}}}')).toThrow(/fps/)
    expect(() => parseCodexPet('{"spritesheetPath":"../evil.webp"}')).toThrow(/inside the pet/)
    expect(() => parseCodexPet('{"spritesheetPath":"/abs.webp"}')).toThrow(/inside the pet/)
  })
})

describe('resolveAnimations', () => {
  const base = parseCodexPet('{}')

  test('defaults mirror the codex row layout', () => {
    const { animations } = resolveAnimations(base)
    // Row 0 idle, 6 frames @1100ms average; row 7 running, 6 frames @120ms.
    expect(animations.idle.sprites).toEqual([0, 1, 2, 3, 4, 5])
    expect(animations.idle.frameDurationMs).toBe(1100)
    expect(animations.running.sprites).toEqual([56, 57, 58, 59, 60, 61])
    expect(animations.running.frameDurationMs).toBe(120)
    expect(animations.review.sprites).toEqual([64, 65, 66, 67, 68, 69])
    // Aliases share the target's frames.
    expect(animations.wave).toBe(animations.waving)
    expect(animations.sad).toBe(animations.failed)
  })

  test('custom animations override defaults and add new names', () => {
    const pet = parseCodexPet(
      '{"animations":{"idle":{"frames":[1,2],"fps":4},"zoomies":{"frames":[8,9,10]}}}',
    )
    const { animations } = resolveAnimations(pet)
    expect(animations.idle.sprites).toEqual([1, 2])
    expect(animations.idle.frameDurationMs).toBe(250)
    expect(animations.zoomies.sprites).toEqual([8, 9, 10])
    // Untouched defaults survive alongside customs (codex semantics).
    expect(animations.waving.sprites).toEqual([24, 25, 26, 27])
  })

  test('out-of-grid animations are dropped, and a missing idle is fatal', () => {
    const small = parseCodexPet(
      '{"frame":{"width":32,"height":32,"columns":2,"rows":2},"animations":{"idle":{"frames":[0,1]}}}',
    )
    const { animations, dropped } = resolveAnimations(small)
    expect(dropped).toContain('running') // row 7 does not exist in a 2x2 grid
    expect(animations.idle.sprites).toEqual([0, 1])
    expect(() =>
      resolveAnimations(parseCodexPet('{"animations":{"idle":{"frames":[99]}}}')),
    ).toThrow(/idle/)
  })
})

describe('buildStripPlan', () => {
  test('maps every codex state onto the 8 moods', () => {
    const { animations } = resolveAnimations(parseCodexPet('{}'))
    const { plan, warnings } = buildStripPlan(animations)
    expect(plan.map((p) => p.mood)).toEqual(MOODS)
    const byMood = Object.fromEntries(plan.map((p) => [p.mood, p]))
    expect(byMood.idle.source).toBe('idle')
    expect(byMood.thinking.source).toBe('review')
    expect(byMood.working.source).toBe('running')
    expect(byMood.waiting.source).toBe('waiting')
    expect(byMood.sad.source).toBe('failed')
    expect(byMood.celebrating.source).toBe('jumping')
    expect(byMood.pet.source).toBe('waving')
    expect(byMood.sleeping.source).toBe('idle-derived')
    expect(byMood.sleeping.sprites).toEqual(byMood.idle.sprites)
    expect(byMood.sleeping.frameDurationMs).toBe(1100 * SLEEP_DURATION_FACTOR)
    expect(warnings).toEqual([])
  })

  test('moods without a source fall back to idle with a warning', () => {
    const { animations } = resolveAnimations(
      parseCodexPet('{"animations":{"idle":{"frames":[0]}}}'),
    )
    // A pet whose sheet only really supports idle: strip every other source.
    for (const name of Object.keys(animations)) {
      if (name !== 'idle') delete animations[name]
    }
    const { plan, warnings } = buildStripPlan(animations)
    for (const mood of ['thinking', 'working', 'waiting', 'sad', 'celebrating', 'pet']) {
      const strip = plan.find((p) => p.mood === mood)
      expect(strip.sprites).toEqual([0])
    }
    expect(warnings.length).toBe(6)
    expect(warnings[0]).toMatch(/reusing idle/)
  })

  test('respects MOOD_SOURCES fallback order', () => {
    const { animations } = resolveAnimations(parseCodexPet('{}'))
    delete animations.running // leaves running-right and move_right
    const { plan } = buildStripPlan(animations)
    expect(plan.find((p) => p.mood === 'working').source).toBe('running-right')
    expect(MOOD_SOURCES.working).toEqual(['running', 'running-right', 'move_right'])
  })
})

describe('capStripFrames', () => {
  test('short strips pass through untouched', () => {
    expect(capStripFrames([1, 2, 3], 100)).toEqual({ sprites: [1, 2, 3], frameDurationMs: 100 })
  })

  test('long strips thin evenly and stretch the duration', () => {
    const sprites = Array.from({ length: 48 }, (_, i) => i)
    const { sprites: kept, frameDurationMs, thinned } = capStripFrames(sprites, 100)
    expect(kept.length).toBeLessThanOrEqual(MAX_STRIP_FRAMES)
    expect(kept[0]).toBe(0)
    expect(thinned).toEqual({ from: 48, to: kept.length })
    expect(frameDurationMs * kept.length).toBeCloseTo(100 * 48, 6)
  })
})

describe('grid geometry', () => {
  const frame = { width: 192, height: 208, columns: 8, rows: 9 }

  test('spriteRect is row-major', () => {
    expect(spriteRect(frame, 0)).toEqual({ x: 0, y: 0, width: 192, height: 208 })
    expect(spriteRect(frame, 9)).toEqual({ x: 192, y: 208, width: 192, height: 208 })
    expect(spriteRect(frame, 71)).toEqual({ x: 7 * 192, y: 8 * 208, width: 192, height: 208 })
    expect(() => spriteRect(frame, 72)).toThrow(/outside/)
    expect(() => spriteRect(frame, -1)).toThrow(/outside/)
  })

  test('assertGridCoversSheet enforces the exact-cover rule', () => {
    expect(() => assertGridCoversSheet(frame, 1536, 1872)).not.toThrow()
    expect(() => assertGridCoversSheet(frame, 1536, 1870)).toThrow(/cover the spritesheet/)
  })

  test('fitFrame aspect-fits and centers (codex cell → square)', () => {
    // 192x208 → 236x256 in a 256 canvas: height fills, pillarboxed by 10px.
    expect(fitFrame(192, 208, 256)).toEqual({ width: 236, height: 256, offsetX: 10, offsetY: 0 })
    // Landscape cells letterbox instead.
    expect(fitFrame(208, 192, 256)).toEqual({ width: 256, height: 236, offsetX: 0, offsetY: 10 })
  })
})

describe('isValidPetId', () => {
  test('accepts tame ids, rejects paths and markup', () => {
    expect(isValidPetId('chefito')).toBe(true)
    expect(isValidPetId('null-signal')).toBe(true)
    expect(isValidPetId('../x')).toBe(false)
    expect(isValidPetId('a b')).toBe(false)
    expect(isValidPetId('-lead')).toBe(false)
    expect(isValidPetId('')).toBe(false)
  })
})
