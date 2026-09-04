/**
 * Import a Codex-compatible pet package (pet.json + spritesheet.webp) as a
 * dsh-pet-desktop sprite set: one horizontal PNG strip per mood under
 * assets/sprites/<id>/ plus a manifest.json entry.
 *
 * Usage (from the repo root):
 *   bun packages/pet-desktop/scripts/import-codex-pet.mjs <codex-pet-dir|pet.json> [--name <id>] [--out <sprites-dir>]
 *
 * WebP decoding: bun has none and the workspace carries no image library
 * (adding one is deliberately avoided). On macOS the built-in `sips`
 * converts WebP → PNG, after which lib/png.mjs (pure JS, node:zlib) takes
 * over. On other platforms install Google's `dwebp` and it is used instead;
 * a spritesheet.png source skips external tools entirely. The tradeoff is a
 * hard dependency on a system converter, in exchange for zero new deps.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { importCodexPet, resolvePetDir } from './lib/import.mjs'
import { decodePng } from './lib/png.mjs'

const SPRITES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sprites')

function usage() {
  console.error(
    'usage: bun packages/pet-desktop/scripts/import-codex-pet.mjs <codex-pet-dir|pet.json> ' +
      '[--name <id>] [--out <sprites-dir>]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  let input = null
  let name = null
  let out = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') {
      name = argv[++i]
      if (!name) usage()
    } else if (argv[i] === '--out') {
      // Import into a staging sprites dir instead of the package assets;
      // must contain a manifest.json to merge into.
      out = argv[++i]
      if (!out) usage()
    } else if (argv[i].startsWith('--')) {
      console.error(`unknown option: ${argv[i]}`)
      usage()
    } else if (input === null) {
      input = argv[i]
    } else {
      usage()
    }
  }
  if (input === null) usage()
  return { input, name, out }
}

/**
 * Sheet decoder for the CLI: PNG is decoded in-process; anything else
 * (spritesheet.webp in practice) goes through a system converter into a
 * temp PNG first.
 */
function makeSheetDecoder() {
  return (sheetPath) => {
    if (sheetPath.toLowerCase().endsWith('.png')) {
      return decodePng(readFileSync(sheetPath))
    }
    const workDir = mkdtempSync(join(tmpdir(), 'codex-pet-'))
    try {
      const pngPath = join(workDir, 'sheet.png')
      convertToPng(sheetPath, pngPath)
      return decodePng(readFileSync(pngPath))
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

function convertToPng(src, dst) {
  if (process.platform === 'darwin') {
    try {
      execFileSync('sips', ['-s', 'format', 'png', src, '--out', dst], { stdio: 'pipe' })
      return
    } catch (err) {
      throw new Error(
        `sips failed to convert ${src}: ${err.stderr?.toString().trim() || err.message}`,
        { cause: err },
      )
    }
  }
  try {
    execFileSync('dwebp', [src, '-o', dst], { stdio: 'pipe' })
  } catch {
    throw new Error(
      `cannot decode ${src}: no WebP decoder available. ` +
        'On macOS this uses the built-in sips; elsewhere install dwebp ' +
        '(https://developers.google.com/speed/webp/download) or convert the sheet to PNG yourself.',
    )
  }
}

function main() {
  const { input, name, out } = parseArgs(process.argv.slice(2))
  const petDir = resolvePetDir(input)
  const spritesDir = out ? resolve(out) : SPRITES_DIR
  const result = importCodexPet({
    petDir,
    petId: name,
    spritesDir,
    decodeSheet: makeSheetDecoder(),
  })

  console.log(
    `imported "${result.id}" → ${join(spritesDir, result.id)} (${result.dstSize}px frames)`,
  )
  for (const row of result.rows) console.log(`  ${row}`)
  for (const warning of result.warnings) console.log(`  warning: ${warning}`)
  console.log(`updated ${result.manifestPath}`)
}

main()
