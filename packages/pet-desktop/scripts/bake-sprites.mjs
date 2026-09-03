/**
 * Bake the web pet's CSS animations into PNG sprite strips for the desktop
 * (Zig, no WebView) player.
 *
 * Technique: one HTML page per (pet, mood) holds N cells of the same SVG, and
 * cell i gets `animation-delay: -(i * step)ms` on every animated descendant,
 * so a single headless-Chrome screenshot captures N animation phases at once
 * as a horizontal strip.
 *
 * Decisions baked in here:
 * - The blink animation (~4.2s period, a 3% keyframe blip) is DISABLED during
 *   baking (`animation: none !important`). Sampling one full blink period
 *   would need ~47 frames of near-identical pixels for every blink-capable
 *   mood; the Zig player can layer its own random blink by swapping in a
 *   closed-eyes frame if it ever wants one.
 * - `alternate` animations (breathe, sleep) are sampled over the full visual
 *   loop (2x the CSS duration) so the strip loops seamlessly.
 * - `sad` has no CSS animation at all (a static pose), so its strip is 4
 *   identical frames — kept at the minimum frame count so the player can
 *   treat every mood uniformly.
 * - The `@media (prefers-reduced-motion: no-preference)` wrapper from
 *   PET_STYLE_CSS is unwrapped so baking never depends on the headless
 *   Chrome's emulated media features.
 *
 * Run: bun packages/pet-desktop/scripts/bake-sprites.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PET_STYLE_CSS, PETS } from '../../pet/src/client/pets.ts'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FRAME_SIZE = 128 // CSS px per frame
const SCALE = 2 // device scale factor → 256 physical px per frame
const MIN_FRAMES = 4
const MAX_FRAMES = 24
const TARGET_STEP_MS = 90

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'assets', 'sprites')

/**
 * Main-animation period per mood, in ms — the loop length the strip must
 * cover. `alternate` animations double their CSS duration (forward + back).
 * Periods are read off the keyframes in PET_STYLE_CSS; if that stylesheet
 * changes, update this table.
 */
const MOOD_PERIODS_MS = {
  idle: 6000, // dsh-pet-breathe 3s alternate
  thinking: 2400, // dsh-pet-tilt 2.4s
  working: 350, // dsh-pet-run 0.35s
  waiting: 1600, // dsh-pet-sway 1.6s
  sad: 360, // static pose; nominal period chosen to land on MIN_FRAMES
  sleeping: 4800, // dsh-pet-sleep 2.4s alternate; zzz (2.4s, offset 1.2s) divides it
  celebrating: 600, // dsh-pet-jump 0.6s
  pet: 500, // dsh-pet-wiggle 0.5s
}

const MOODS = Object.keys(MOOD_PERIODS_MS)

function framesFor(periodMs) {
  const frames = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.ceil(periodMs / TARGET_STEP_MS)))
  return { frames, stepMs: periodMs / frames }
}

/**
 * PET_STYLE_CSS with the prefers-reduced-motion media wrapper removed, plus
 * bake-only overrides: blink off, and per-cell negative animation-delay rules.
 * The per-cell selectors (`.cell[data-i="N"] …`) deliberately out-specify the
 * mood rules in the stylesheet, so no !important is needed for the delays —
 * except on blink, which must beat the mood-agnostic blink rule for good.
 */
function bakeCss(maxFrames) {
  const marker = '@media (prefers-reduced-motion: no-preference) {'
  if (!PET_STYLE_CSS.includes(marker)) {
    throw new Error('PET_STYLE_CSS no longer wraps animations in the expected media query')
  }
  const unwrapped = PET_STYLE_CSS.split(marker).join('').replace(/}\s*$/, '')

  const rules = [
    'html, body { margin: 0; padding: 0; background: transparent; }',
    `.strip { display: flex; width: ${FRAME_SIZE * maxFrames}px; height: ${FRAME_SIZE}px; }`,
    `.cell { width: ${FRAME_SIZE}px; height: ${FRAME_SIZE}px; flex: none; }`,
    // Blink is a rare, instant event; sampling it per-frame is wasteful. Off.
    '.dsh-pet-svg .dsh-pet-blink { animation: none !important; }',
  ]
  for (let i = 0; i < maxFrames; i++) {
    rules.push(
      `.cell[data-i="${i}"] .dsh-pet-body, .cell[data-i="${i}"] .dsh-pet-zzz text { animation-delay: calc(-1 * ${i} * var(--step)); }`,
      // The second Z carries its own +1.2s stagger in the stylesheet; keep it.
      `.cell[data-i="${i}"] .dsh-pet-zzz text:nth-child(2) { animation-delay: calc(1.2s - ${i} * var(--step)); }`,
    )
  }
  return `${unwrapped}\n${rules.join('\n')}`
}

function pageHtml(svg, frames, stepMs) {
  const cells = Array.from(
    { length: frames },
    (_, i) => `<div class="cell" data-i="${i}">${svg}</div>`,
  ).join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root { --step: ${stepMs}ms; }
${bakeCss(frames)}
</style></head><body><div class="strip">${cells}</div></body></html>`
}

/**
 * Chrome 152 headless writes the screenshot and then hangs instead of
 * exiting (verified on macOS: the PNG is complete on disk while the process
 * lingers). So we don't wait for exit — we poll the output file until its
 * size is stable across a few polls, then SIGKILL the browser.
 */
async function runChrome(args, outPath) {
  const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const deadline = Date.now() + 60_000
  let lastSize = -1
  let stablePolls = 0
  for (;;) {
    let size = -1
    try {
      size = statSync(outPath).size
    } catch {
      // not written yet
    }
    if (size > 0 && size === lastSize) {
      stablePolls++
      if (stablePolls >= 3) break
    } else {
      stablePolls = 0
      lastSize = size
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`timeout waiting for ${outPath}: ${stderr.trim().slice(-500)}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }

  child.kill('SIGKILL')
  await new Promise((resolvePromise) => child.once('close', resolvePromise))
}

/** PNG width/height from the IHDR, to sanity-check what Chrome wrote. */
function pngSize(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function bakeOne(pet, mood, workDir, profileDir) {
  const { frames, stepMs } = framesFor(MOOD_PERIODS_MS[mood])
  const html = pageHtml(pet.svg(mood), frames, stepMs)
  const pagePath = join(workDir, `${pet.id}-${mood}.html`)
  writeFileSync(pagePath, html)

  const outDir = join(OUT_DIR, pet.id)
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${mood}.png`)
  // The stability poll must watch a fresh write, not last run's leftovers.
  rmSync(outPath, { force: true })

  await runChrome(
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--force-device-scale-factor=${SCALE}`,
      `--window-size=${FRAME_SIZE * frames},${FRAME_SIZE}`,
      `--user-data-dir=${profileDir}`,
      `--screenshot=${outPath}`,
      pathToFileURL(pagePath).href,
    ],
    outPath,
  )

  const { width, height } = pngSize(outPath)
  const expected = { width: FRAME_SIZE * frames * SCALE, height: FRAME_SIZE * SCALE }
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `${pet.id}/${mood}: got ${width}x${height}, expected ${expected.width}x${expected.height}`,
    )
  }
  return { frames, stepMs, bytes: statSync(outPath).size }
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'bake-sprites-'))
  try {
    const manifest = { scale: SCALE, frameSize: FRAME_SIZE, pets: {} }
    let totalBytes = 0
    const rows = []

    for (const pet of PETS) {
      manifest.pets[pet.id] = { moods: {} }
      for (const mood of MOODS) {
        const profileDir = join(workDir, `profile-${pet.id}-${mood}`)
        const { frames, stepMs, bytes } = await bakeOne(pet, mood, workDir, profileDir)
        totalBytes += bytes
        manifest.pets[pet.id].moods[mood] = {
          file: `${pet.id}/${mood}.png`,
          frames,
          frameDurationMs: Math.round(stepMs * 1000) / 1000,
        }
        rows.push(
          `${pet.id}/${mood}.png  frames=${frames}  step=${stepMs.toFixed(1)}ms  ${(bytes / 1024).toFixed(1)}KiB`,
        )
      }
    }

    const manifestPath = join(OUT_DIR, 'manifest.json')
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    totalBytes += statSync(manifestPath).size

    console.log(`baked ${rows.length} strips → ${OUT_DIR}`)
    for (const row of rows) console.log(`  ${row}`)
    console.log(`  manifest.json  ${(statSync(manifestPath).size / 1024).toFixed(1)}KiB`)
    console.log(`total ${(totalBytes / 1024).toFixed(1)}KiB`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
