/**
 * Codex pet → dsh-pet-desktop sprite import, I/O core. The CLI in
 * scripts/import-codex-pet.mjs is a thin wrapper around `importCodexPet`;
 * keeping the pipeline here (with the output directory and the WebP→PNG
 * converter injectable) is what makes it testable without touching the
 * real assets.
 *
 * Pipeline: pet.json → resolve animations + mood strip plan (lib/codex-pet)
 * → decode the sheet (WebP goes through an external converter first — bun
 * has no WebP decoder and the workspace has no image library) → slice
 * row-major sprite rects → aspect-fit each frame onto a square canvas at
 * the manifest's physical frame size → encode one horizontal PNG strip per
 * mood → update manifest.json under the src/manifest.zig contract.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  assertGridCoversSheet,
  buildStripPlan,
  fitFrame,
  isValidPetId,
  MAX_PETS,
  MOODS,
  parseCodexPet,
  resolveAnimations,
  spriteRect,
} from './codex-pet.mjs'
import { mirrorPngBytes } from './mirror.mjs'
import { encodePng } from './png.mjs'

/**
 * Locate the pet package directory from a directory or a pet.json path,
 * like model.rs load_pet_path.
 */
export function resolvePetDir(inputPath) {
  const full = resolve(inputPath)
  if (!existsSync(full)) throw new Error(`no such path: ${inputPath}`)
  const dir = statSync(full).isDirectory() ? full : dirname(full)
  if (!existsSync(join(dir, 'pet.json'))) throw new Error(`missing pet.json in ${dir}`)
  return dir
}

/**
 * Bilinear-resample one RGBA frame onto a transparent dst x dst canvas,
 * aspect-fit and centered. Colors are alpha-weighted (premultiplied) during
 * interpolation so semi-transparent edges don't pick up halo colors from
 * fully transparent neighbors.
 */
export function placeFrame(sheet, rect, dstSize) {
  const fit = fitFrame(rect.width, rect.height, dstSize)
  const out = Buffer.alloc(dstSize * dstSize * 4)
  const scale = fit.width / rect.width
  for (let dy = 0; dy < fit.height; dy++) {
    for (let dx = 0; dx < fit.width; dx++) {
      const sx = (dx + 0.5) / scale + rect.x - 0.5
      const sy = (dy + 0.5) / scale + rect.y - 0.5
      const x0 = Math.max(rect.x, Math.floor(sx))
      const y0 = Math.max(rect.y, Math.floor(sy))
      const x1 = Math.min(rect.x + rect.width - 1, x0 + 1)
      const y1 = Math.min(rect.y + rect.height - 1, y0 + 1)
      const fx = Math.min(1, Math.max(0, sx - x0))
      const fy = Math.min(1, Math.max(0, sy - y0))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (const [cx, cy, w] of [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ]) {
        const i = (cy * sheet.width + cx) * 4
        const wa = w * (sheet.data[i + 3] / 255)
        r += sheet.data[i] * wa
        g += sheet.data[i + 1] * wa
        b += sheet.data[i + 2] * wa
        a += wa
      }
      const d = ((fit.offsetY + dy) * dstSize + fit.offsetX + dx) * 4
      if (a > 0) {
        out[d] = Math.round(r / a)
        out[d + 1] = Math.round(g / a)
        out[d + 2] = Math.round(b / a)
        out[d + 3] = Math.round(a * 255)
      }
    }
  }
  return out
}

/** Concatenate fitted frames into one horizontal RGBA strip and encode. */
export function buildStripPng(sheet, sprites, frame, dstSize) {
  const strip = Buffer.alloc(sprites.length * dstSize * dstSize * 4)
  sprites.forEach((index, i) => {
    const placed = placeFrame(sheet, spriteRect(frame, index), dstSize)
    for (let y = 0; y < dstSize; y++) {
      placed.copy(
        strip,
        (y * sprites.length + i) * dstSize * 4,
        y * dstSize * 4,
        (y + 1) * dstSize * 4,
      )
    }
  })
  return encodePng({ width: sprites.length * dstSize, height: dstSize, data: strip })
}

/**
 * Import one Codex pet package.
 *
 * options:
 * - petDir: directory holding pet.json + the spritesheet
 * - petId: target id (defaults to pet.json's id, then the directory name)
 * - spritesDir: assets/sprites to write into
 * - decodeSheet: (spritesheetPath) => { width, height, data } — the CLI
 *   passes one that shells out to sips for WebP; tests pass a PNG decoder.
 */
export function importCodexPet({ petDir, petId, spritesDir, decodeSheet }) {
  const pet = parseCodexPet(readFileSync(join(petDir, 'pet.json'), 'utf8'))
  const id = petId ?? (pet.id && isValidPetId(pet.id) ? pet.id : null) ?? basenameAsId(petDir)
  if (!isValidPetId(id)) {
    throw new Error(`invalid pet id "${id}" (want [a-z0-9-]); pass --name to pick one`)
  }

  const manifestPath = join(spritesDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // src/manifest.zig: scale/frameSize are global, frames are square at
  // frameSize*scale physical pixels, and the pets table caps at MAX_PETS.
  if (typeof manifest.scale !== 'number' || typeof manifest.frameSize !== 'number') {
    throw new Error(`${manifestPath}: missing scale/frameSize`)
  }
  const dstSize = manifest.frameSize * manifest.scale
  const existing = Object.keys(manifest.pets ?? {})
  if (!existing.includes(id) && existing.length >= MAX_PETS) {
    throw new Error(
      `manifest already has ${existing.length} pets (${existing.join(', ')}); ` +
        `src/manifest.zig caps at ${MAX_PETS} — remove one or replace an imported pet`,
    )
  }

  const sheetPath = join(petDir, pet.spritesheetPath)
  if (!existsSync(sheetPath)) {
    throw new Error(`missing spritesheet ${sheetPath}`)
  }
  const sheet = decodeSheet(sheetPath)
  assertGridCoversSheet(pet.frame, sheet.width, sheet.height)

  const { animations, dropped } = resolveAnimations(pet)
  const { plan, warnings } = buildStripPlan(animations)
  // Warn only about user-authored animations that failed — out-of-grid
  // built-in defaults are expected on small custom grids, and moods whose
  // sources all vanished already warn via the idle fallback.
  for (const name of dropped) {
    if (pet.animations[name]) {
      warnings.unshift(`animation "${name}" points outside the frame grid; ignored`)
    }
  }

  const outDir = join(spritesDir, id)
  mkdirSync(outDir, { recursive: true })
  const moods = {}
  const rows = []
  for (const strip of plan) {
    const png = buildStripPng(sheet, strip.sprites, pet.frame, dstSize)
    writeFileSync(join(outDir, `${strip.mood}.png`), png)
    moods[strip.mood] = {
      file: `${id}/${strip.mood}.png`,
      frames: strip.sprites.length,
      frameDurationMs: strip.frameDurationMs,
    }
    if (strip.mood === 'working') {
      // The pre-mirrored run strip the app swaps in for rightward drags
      // (the SDK's software reference renderer drops negative-scale
      // transforms — see scripts/lib/mirror.mjs).
      writeFileSync(join(outDir, 'working-mirrored.png'), mirrorPngBytes(png, strip.sprites.length))
      moods.working.mirroredFile = `${id}/working-mirrored.png`
    }
    rows.push(
      `${id}/${strip.mood}.png  frames=${strip.sprites.length}  ` +
        `step=${strip.frameDurationMs}ms  from=${strip.source}  ${(png.length / 1024).toFixed(1)}KiB`,
    )
  }

  // Canonical mood order, matching src/state.zig's Mood enum.
  manifest.pets[id] = {
    moods: Object.fromEntries(MOODS.map((mood) => [mood, moods[mood]])),
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return { id, dstSize, rows, warnings, manifestPath }
}

function basenameAsId(petDir) {
  const base =
    petDir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}
