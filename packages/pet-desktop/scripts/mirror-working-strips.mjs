#!/usr/bin/env node
// Generates <pet>/working-mirrored.png — the working (run) strip with each
// frame mirrored horizontally in place — for every pet in manifest.json,
// and sets "mirroredFile" on the pet's working mood entry. Idempotent.
//
// Why: the SDK's software reference renderer (which Windows transparent
// windows always take) drops the sign of a negative-scale Affine, so the
// draw-time mirror the view uses on Metal is not portable; the app swaps
// in this pre-mirrored strip instead. See scripts/lib/mirror.mjs and
// docs/zero-native-notes.md.
//
// Re-run with: bun packages/pet-desktop/scripts/mirror-working-strips.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mirrorStrip } from './lib/mirror.mjs'
import { decodePng, encodePng } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const spritesDir = join(here, '..', 'assets', 'sprites')
const manifestPath = join(spritesDir, 'manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

for (const [petId, pet] of Object.entries(manifest.pets ?? {})) {
  const working = pet.moods?.working
  if (!working) {
    console.log(`skipping ${petId}: no working mood`)
    continue
  }
  const png = decodePng(readFileSync(join(spritesDir, working.file)))
  const mirrored = encodePng(mirrorStrip(png, working.frames))
  const mirroredFile = `${petId}/working-mirrored.png`
  writeFileSync(join(spritesDir, mirroredFile), mirrored)
  working.mirroredFile = mirroredFile
  console.log(
    `${mirroredFile}  frames=${working.frames}  ${png.width}x${png.height}  ` +
      `${(mirrored.length / 1024).toFixed(1)}KiB`,
  )
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`updated ${manifestPath}`)
