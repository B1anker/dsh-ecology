/**
 * Codec and end-to-end tests for the Codex pet importer: PNG encode/decode
 * round-trips and a full import of a programmatically generated mock package
 * (no real Codex artwork — fixtures are synthesized pixels). Run with:
 *   bun test packages/pet-desktop/test
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_PETS } from '../scripts/lib/codex-pet.mjs'
import { importCodexPet } from '../scripts/lib/import.mjs'
import { decodePng, encodePng } from '../scripts/lib/png.mjs'

/** Solid-color RGBA buffer. */
function solid(width, height, [r, g, b, a]) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return data
}

/** A grid sheet where every cell is one distinct opaque color. */
function mockSheet({ width, height, columns, rows }) {
  const data = Buffer.alloc(width * columns * height * rows * 4)
  for (let index = 0; index < columns * rows; index++) {
    const cell = solid(width, height, [(index * 37) % 256, (index * 91) % 256, 200, 255])
    for (let y = 0; y < height; y++) {
      const dstRow = Math.floor(index / columns) * height + y
      const dstCol = (index % columns) * width
      cell.copy(data, (dstRow * width * columns + dstCol) * 4, y * width * 4, (y + 1) * width * 4)
    }
  }
  return { width: width * columns, height: height * rows, data }
}

describe('png codec', () => {
  test('encode → decode round-trips RGBA pixels', () => {
    const pixels = solid(3, 2, [10, 20, 30, 40])
    pixels[0] = 255 // make one pixel distinct
    const decoded = decodePng(encodePng({ width: 3, height: 2, data: pixels }))
    expect(decoded.width).toBe(3)
    expect(decoded.height).toBe(2)
    expect(Buffer.from(decoded.data)).toEqual(Buffer.from(pixels))
  })

  test('decode rejects non-PNG and unsupported variants', () => {
    expect(() => decodePng(Buffer.from('nope'))).toThrow(/not a PNG/)
    const png = encodePng({ width: 1, height: 1, data: solid(1, 1, [0, 0, 0, 255]) })
    const palette = Buffer.from(png)
    palette[25] = 3 // IHDR color type byte (sig 8 + len 4 + type 4 + data offset 9): palette — unsupported
    expect(() => decodePng(palette)).toThrow(/unsupported PNG/)
  })

  test('encode rejects mismatched buffers', () => {
    expect(() => encodePng({ width: 2, height: 2, data: Buffer.alloc(4) })).toThrow(
      /does not match/,
    )
  })
})

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'import-codex-pet-'))
  const spritesDir = join(root, 'sprites')
  mkdirSync(spritesDir, { recursive: true })
  writeFileSync(
    join(spritesDir, 'manifest.json'),
    `${JSON.stringify({ scale: 2, frameSize: 128, pets: { blob: { moods: {} } } })}\n`,
  )
  return { root, spritesDir }
}

/** Mock package: 16x16 cells in a 4x2 grid (sheet 64x32), PNG source. */
function makeMockPet(root, animations) {
  const petDir = join(root, 'mockpet')
  mkdirSync(petDir, { recursive: true })
  const frame = { width: 16, height: 16, columns: 4, rows: 2 }
  const sheet = mockSheet(frame)
  writeFileSync(join(petDir, 'spritesheet.png'), encodePng(sheet))
  writeFileSync(
    join(petDir, 'pet.json'),
    JSON.stringify({ id: 'mockpet', spritesheetPath: 'spritesheet.png', frame, animations }),
  )
  return petDir
}

const decodePngFile = (path) => decodePng(readFileSync(path))

describe('importCodexPet', () => {
  test('imports all 8 moods as contract-shaped strips', () => {
    const { root, spritesDir } = makeWorkspace()
    try {
      const petDir = makeMockPet(root, {
        idle: { frames: [0, 1], fps: 10 },
        running: { frames: [2, 3], fps: 20 },
        waving: { frames: [4] },
        jumping: { frames: [5] },
        failed: { frames: [6] },
        waiting: { frames: [7] },
        review: { frames: [1, 0] },
      })
      const result = importCodexPet({ petDir, petId: null, spritesDir, decodeSheet: decodePngFile })

      expect(result.id).toBe('mockpet')
      expect(result.dstSize).toBe(256)
      expect(result.warnings).toEqual([])

      const manifest = JSON.parse(readFileSync(join(spritesDir, 'manifest.json'), 'utf8'))
      expect(manifest.pets.blob).toBeDefined() // pre-existing pets survive
      const moods = manifest.pets.mockpet.moods
      expect(Object.keys(moods)).toEqual([
        'idle',
        'thinking',
        'working',
        'waiting',
        'sad',
        'sleeping',
        'celebrating',
        'pet',
      ])
      expect(moods.idle).toEqual({ file: 'mockpet/idle.png', frames: 2, frameDurationMs: 100 })
      expect(moods.working).toEqual({ file: 'mockpet/working.png', frames: 2, frameDurationMs: 50 })
      expect(moods.sleeping).toEqual({
        file: 'mockpet/sleeping.png',
        frames: 2,
        frameDurationMs: 150,
      })

      // Strip geometry and content: N 256px frames side by side, each a
      // solid block of its sprite's color.
      const idle = decodePng(readFileSync(join(spritesDir, 'mockpet', 'idle.png')))
      expect([idle.width, idle.height]).toEqual([512, 256])
      const px = (x, y) => [
        idle.data[(y * idle.width + x) * 4],
        idle.data[(y * idle.width + x) * 4 + 1],
        idle.data[(y * idle.width + x) * 4 + 2],
        idle.data[(y * idle.width + x) * 4 + 3],
      ]
      expect(px(128, 128)).toEqual([0, 0, 200, 255]) // sprite 0
      expect(px(384, 128)).toEqual([37, 91, 200, 255]) // sprite 1
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing moods degrade to idle frames with warnings', () => {
    const { root, spritesDir } = makeWorkspace()
    try {
      const petDir = makeMockPet(root, { idle: { frames: [3], fps: 5 } })
      const result = importCodexPet({ petDir, petId: null, spritesDir, decodeSheet: decodePngFile })
      expect(result.warnings.length).toBeGreaterThan(0)
      const manifest = JSON.parse(readFileSync(join(spritesDir, 'manifest.json'), 'utf8'))
      for (const mood of Object.keys(manifest.pets.mockpet.moods)) {
        expect(manifest.pets.mockpet.moods[mood].frames).toBe(1)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a pet beyond capacity (src/manifest.zig max_pets)', () => {
    const { root, spritesDir } = makeWorkspace()
    try {
      const manifest = JSON.parse(readFileSync(join(spritesDir, 'manifest.json'), 'utf8'))
      // blob is seeded already; fill the table right up to MAX_PETS.
      for (let i = 0; Object.keys(manifest.pets).length < MAX_PETS; i++)
        manifest.pets[`filler${i}`] = { moods: {} }
      writeFileSync(join(spritesDir, 'manifest.json'), JSON.stringify(manifest))
      const petDir = makeMockPet(root, { idle: { frames: [0] } })
      expect(() =>
        importCodexPet({ petDir, petId: null, spritesDir, decodeSheet: decodePngFile }),
      ).toThrow(new RegExp(`caps at ${MAX_PETS}`))
      // Replacing an existing pet is allowed even at capacity.
      manifest.pets.mockpet = { moods: {} }
      writeFileSync(join(spritesDir, 'manifest.json'), JSON.stringify(manifest))
      expect(() =>
        importCodexPet({ petDir, petId: null, spritesDir, decodeSheet: decodePngFile }),
      ).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a grid that does not cover the sheet', () => {
    const { root, spritesDir } = makeWorkspace()
    try {
      const petDir = makeMockPet(root, { idle: { frames: [0] } })
      const bad = JSON.parse(readFileSync(join(petDir, 'pet.json'), 'utf8'))
      bad.frame.rows = 3 // sheet is only 2 rows tall
      writeFileSync(join(petDir, 'pet.json'), JSON.stringify(bad))
      expect(() =>
        importCodexPet({ petDir, petId: null, spritesDir, decodeSheet: decodePngFile }),
      ).toThrow(/cover the spritesheet/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects unusable pet ids', () => {
    const { root, spritesDir } = makeWorkspace()
    try {
      const petDir = makeMockPet(root, { idle: { frames: [0] } })
      expect(() =>
        importCodexPet({ petDir, petId: 'bad id!', spritesDir, decodeSheet: decodePngFile }),
      ).toThrow(/invalid pet id/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
