/**
 * Codex pet package parsing and mood mapping — pure logic, no I/O.
 *
 * The Codex format below is verified against the upstream source
 * (openai/codex, codex-rs/tui/src/pets/model.rs + catalog.rs + frames.rs):
 *
 * - A pet package is a directory with `pet.json` + a spritesheet
 *   (`spritesheetPath`, default `spritesheet.webp`, must stay inside the
 *   package directory).
 * - `pet.json`: { id?, displayName?, description?, spriteVersionNumber?,
 *   spritesheetPath?, frame?: { width, height, columns, rows },
 *   animations?: { <name>: { frames: number[], fps?, loop?, fallback? } } }.
 * - Default frame spec depends on `spriteVersionNumber`: v1 (field absent)
 *   is 192x208 cells in an 8x9 grid (sheet 1536x1872, codex-rs TUI);
 *   v2 is the same cells in an 8x11 grid (sheet 1536x2288, Codex desktop
 *   app), whose extra rows 9-10 hold 16 look-direction poses. The look rows
 *   have no counterpart in our player and are ignored on import. In both
 *   versions the grid must cover the sheet exactly and hold at most 256
 *   frames.
 * - Sprite indices are row-major: index = row * columns + column.
 * - When `animations` is absent/empty, Codex uses built-in defaults where
 *   each grid ROW is one state: 0 idle, 1 running-right, 2 running-left,
 *   3 waving, 4 jumping, 5 failed, 6 waiting, 7 running, 8 review — plus the
 *   aliases move_right/move_left/wave/bounce/sad. Custom animations override
 *   same-named defaults and use uniform timing (1000/fps ms, default 8 fps).
 * - Codex's idle default carries per-frame durations; our strips take one
 *   frameDurationMs per strip, so the average is used.
 * - Codex's non-idle defaults repeat the primary frames 3x and then chain
 *   the idle frames (loop_start semantics). Our player loops one strip
 *   seamlessly, so only the primary frames are imported.
 */

/** Our 8 moods, in the canonical order of src/state.zig's Mood enum. */
export const MOODS = [
  'idle',
  'thinking',
  'working',
  'waiting',
  'sad',
  'sleeping',
  'celebrating',
  'pet',
]

/** Codex default frame specs (catalog.rs for v1; the desktop app's v2 adds
 *  two look-direction rows). */
export const DEFAULT_FRAME = Object.freeze({ width: 192, height: 208, columns: 8, rows: 9 })
export const DEFAULT_FRAME_V2 = Object.freeze({ ...DEFAULT_FRAME, rows: 11 })

/** `spriteVersionNumber` values whose default grid layout is known. */
export const SPRITE_VERSIONS = Object.freeze({ 1: DEFAULT_FRAME, 2: DEFAULT_FRAME_V2 })

/** Codex's hard caps (model.rs). */
export const MAX_PET_FRAMES = 256
export const MAX_ANIMATION_FPS = 60
export const DEFAULT_ANIMATION_FPS = 8

/**
 * Strip frame ceiling for our player. The decode budget in app.zon is
 * 8 MiB per image and a frame is 256x256 RGBA (256 KiB), so 32 frames is the
 * absolute edge; bake-sprites.mjs already caps at 24, and imported strips
 * stay under the same ceiling to keep headroom.
 */
export const MAX_STRIP_FRAMES = 24

/**
 * src/manifest.zig `max_pets` — the manifest parse fails wholesale when the
 * pets table grows past this, so the importer must refuse instead.
 */
export const MAX_PETS = 8

/**
 * Default Codex animations, mirroring model.rs `default_animations()` but
 * reduced to the primary frames with one uniform duration (see the file
 * header for why the 3x-repeat + idle tail is dropped). Idle uses the
 * average of its per-frame durations: (1680+660+660+840+840+1920)/6 = 1100.
 */
const DEFAULT_ROWS = [
  ['idle', 0, 6, 1100],
  ['running-right', 1, 8, 120],
  ['running-left', 2, 8, 120],
  ['waving', 3, 4, 140],
  ['jumping', 4, 5, 140],
  ['failed', 5, 8, 140],
  ['waiting', 6, 6, 150],
  ['running', 7, 6, 120],
  ['review', 8, 6, 150],
]

/** Aliases Codex registers next to the defaults (same frames and timing). */
const DEFAULT_ALIASES = {
  move_right: 'running-right',
  move_left: 'running-left',
  wave: 'waving',
  bounce: 'jumping',
  sad: 'failed',
}

/**
 * Mood → ordered Codex animation names to try; the first one present wins.
 * `sleeping` has no Codex counterpart: a custom `sleeping`/`sleep` animation
 * is used when the package provides one, otherwise it is derived from idle
 * (see SLEEP_DURATION_FACTOR).
 */
export const MOOD_SOURCES = Object.freeze({
  idle: ['idle'],
  thinking: ['review'],
  working: ['running', 'running-right', 'move_right'],
  waiting: ['waiting'],
  sad: ['failed', 'sad'],
  sleeping: ['sleeping', 'sleep', 'rest'],
  celebrating: ['jumping', 'bounce'],
  pet: ['waving', 'wave'],
})

/** Derived `sleeping` strips replay the idle frames this much slower. */
export const SLEEP_DURATION_FACTOR = 1.5

/** Pet ids become directory names and manifest keys; keep them tame. */
export function isValidPetId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
}

function fail(message) {
  throw new Error(`pet.json: ${message}`)
}

/**
 * Parse and validate a Codex pet.json document. Mirrors the checks in
 * model.rs (PetFile / AnimationSpec / validate_frame_spec) closely enough
 * that anything Codex itself rejects is rejected here too — except the
 * sheet-dimensions check, which needs the decoded image and lives in
 * `assertGridCoversSheet`.
 */
export function parseCodexPet(jsonText) {
  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch (err) {
    fail(`invalid JSON: ${err.message}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('top level must be an object')
  }

  const spriteVersion = parseSpriteVersion(raw.spriteVersionNumber)
  const frame =
    raw.frame === undefined ? { ...SPRITE_VERSIONS[spriteVersion] } : parseFrameSpec(raw.frame)

  const animations = {}
  if (raw.animations !== undefined) {
    if (
      raw.animations === null ||
      typeof raw.animations !== 'object' ||
      Array.isArray(raw.animations)
    ) {
      fail('animations must be an object')
    }
    for (const [name, spec] of Object.entries(raw.animations)) {
      animations[name] = parseAnimationSpec(name, spec)
    }
  }

  const spritesheetPath =
    raw.spritesheetPath === undefined
      ? 'spritesheet.webp'
      : parseSpritesheetPath(raw.spritesheetPath)

  return {
    id: raw.id === undefined ? null : parseOptionalString('id', raw.id),
    displayName:
      raw.displayName === undefined ? null : parseOptionalString('displayName', raw.displayName),
    description:
      raw.description === undefined ? '' : parseOptionalString('description', raw.description),
    spritesheetPath,
    spriteVersion,
    frame,
    animations,
    customAnimations: Object.keys(animations).length > 0,
  }
}

function parseSpriteVersion(value) {
  if (value === undefined) return 1
  if (!Number.isInteger(value) || !SPRITE_VERSIONS[value]) {
    fail(`spriteVersionNumber must be one of ${Object.keys(SPRITE_VERSIONS).join(', ')}`)
  }
  return value
}

function parseOptionalString(field, value) {
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value.trim()
}

function parseSpritesheetPath(value) {
  if (typeof value !== 'string' || value.trim() === '')
    fail('spritesheetPath must be a non-empty string')
  const path = value.trim()
  // Same sandbox rule as model.rs resolve_spritesheet_path: relative child
  // paths only, never absolute, never escaping the package directory.
  if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:/.test(path)) {
    fail(`spritesheetPath must stay inside the pet directory: ${path}`)
  }
  if (path.split(/[\\/]/).includes('..')) {
    fail(`spritesheetPath must stay inside the pet directory: ${path}`)
  }
  return path
}

function parseFrameSpec(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('frame must be an object { width, height, columns, rows }')
  }
  const frame = {}
  for (const key of ['width', 'height', 'columns', 'rows']) {
    const v = value[key]
    if (!Number.isInteger(v) || v <= 0) fail(`frame.${key} must be a positive integer`)
    frame[key] = v
  }
  if (frame.columns * frame.rows > MAX_PET_FRAMES) {
    fail(`frame grid ${frame.columns}x${frame.rows} exceeds ${MAX_PET_FRAMES} frames`)
  }
  return frame
}

function parseAnimationSpec(name, spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    fail(`animation ${name} must be an object`)
  }
  if (!Array.isArray(spec.frames) || spec.frames.length === 0) {
    fail(`animation ${name} must include at least one frame`)
  }
  for (const index of spec.frames) {
    if (!Number.isInteger(index) || index < 0) {
      fail(`animation ${name} has a bad sprite index: ${index}`)
    }
  }
  let fps = DEFAULT_ANIMATION_FPS
  if (spec.fps !== undefined) {
    if (
      typeof spec.fps !== 'number' ||
      !Number.isFinite(spec.fps) ||
      spec.fps <= 0 ||
      spec.fps > MAX_ANIMATION_FPS
    ) {
      fail(`animation ${name} fps must be finite and between 0 and ${MAX_ANIMATION_FPS}`)
    }
    fps = spec.fps
  }
  return { frames: [...spec.frames], fps }
}

/** Row-major sprite rectangle in the sheet, as in frames.rs. */
export function spriteRect(frame, index) {
  if (!Number.isInteger(index) || index < 0 || index >= frame.columns * frame.rows) {
    throw new Error(`sprite index ${index} outside the ${frame.columns}x${frame.rows} grid`)
  }
  const row = Math.floor(index / frame.columns)
  const column = index % frame.columns
  return {
    x: column * frame.width,
    y: row * frame.height,
    width: frame.width,
    height: frame.height,
  }
}

/** Codex validates the frame grid against the decoded sheet; so do we. */
export function assertGridCoversSheet(frame, sheetWidth, sheetHeight) {
  const totalWidth = frame.width * frame.columns
  const totalHeight = frame.height * frame.rows
  if (totalWidth !== sheetWidth || totalHeight !== sheetHeight) {
    throw new Error(
      `frame grid must cover the spritesheet exactly: sheet is ${sheetWidth}x${sheetHeight}, ` +
        `grid is ${totalWidth}x${totalHeight} (${frame.columns}x${frame.rows} of ` +
        `${frame.width}x${frame.height})`,
    )
  }
}

/**
 * The animations of a pet: built-in defaults overlaid with the custom specs
 * from pet.json (Codex semantics). Entries whose sprite indices fall outside
 * the grid are dropped and reported — that situation is a hard error in
 * Codex itself, but for import we can still salvage the valid ones because
 * every mood falls back to idle when its source is missing.
 */
export function resolveAnimations(pet) {
  const animations = {}
  const dropped = []
  // Codex overlays custom specs on the full default table (model.rs
  // load_animations): defaults stay available for every name the package
  // does not redefine.
  for (const [name, row, frameCount, durationMs] of DEFAULT_ROWS) {
    animations[name] = {
      sprites: Array.from({ length: frameCount }, (_, i) => row * pet.frame.columns + i),
      frameDurationMs: durationMs,
    }
  }
  for (const [alias, target] of Object.entries(DEFAULT_ALIASES)) {
    animations[alias] = animations[target]
  }
  for (const [name, spec] of Object.entries(pet.animations)) {
    animations[name] = { sprites: spec.frames, frameDurationMs: 1000 / spec.fps }
  }

  const frameCount = pet.frame.columns * pet.frame.rows
  for (const [name, animation] of Object.entries(animations)) {
    if (animation.sprites.some((index) => index >= frameCount)) {
      dropped.push(name)
      delete animations[name]
    }
  }
  if (!animations.idle) {
    throw new Error('pet.json: no usable "idle" animation (missing or outside the frame grid)')
  }
  return { animations, dropped }
}

/**
 * Evenly thin a sprite list down to at most MAX_STRIP_FRAMES entries,
 * stretching frameDurationMs so the total loop duration is preserved.
 */
export function capStripFrames(sprites, frameDurationMs) {
  if (sprites.length <= MAX_STRIP_FRAMES) {
    return { sprites, frameDurationMs }
  }
  const stride = Math.ceil(sprites.length / MAX_STRIP_FRAMES)
  const kept = sprites.filter((_, i) => i % stride === 0)
  return {
    sprites: kept,
    frameDurationMs: (frameDurationMs * sprites.length) / kept.length,
    thinned: { from: sprites.length, to: kept.length },
  }
}

/**
 * Map resolved Codex animations onto our 8 moods. Returns one strip plan per
 * mood: { mood, sprites, frameDurationMs, source } where source is the Codex
 * animation the frames came from ('idle-derived' for a synthesized sleeping)
 * plus a warnings list for moods that had to fall back to idle.
 */
export function buildStripPlan(animations) {
  const plan = []
  const warnings = []
  for (const mood of MOODS) {
    let source = null
    for (const candidate of MOOD_SOURCES[mood]) {
      if (animations[candidate]) {
        source = candidate
        break
      }
    }

    let sprites
    let frameDurationMs
    if (mood === 'sleeping' && source === null) {
      sprites = animations.idle.sprites
      frameDurationMs = animations.idle.frameDurationMs * SLEEP_DURATION_FACTOR
      source = 'idle-derived'
    } else if (source === null) {
      sprites = animations.idle.sprites
      frameDurationMs = animations.idle.frameDurationMs
      source = 'idle'
      warnings.push(
        `mood "${mood}": no ${MOOD_SOURCES[mood].join('/')} animation, reusing idle frames`,
      )
    } else {
      sprites = animations[source].sprites
      frameDurationMs = animations[source].frameDurationMs
    }

    const capped = capStripFrames(sprites, frameDurationMs)
    if (capped.thinned) {
      warnings.push(
        `mood "${mood}": thinned ${capped.thinned.from} frames to ${capped.thinned.to} ` +
          `(strip ceiling ${MAX_STRIP_FRAMES})`,
      )
    }
    plan.push({
      mood,
      sprites: capped.sprites,
      // 3 decimals, matching bake-sprites.mjs; manifest.zig takes f64.
      frameDurationMs: Math.round(capped.frameDurationMs * 1000) / 1000,
      source,
    })
  }
  return { plan, warnings }
}

/**
 * Aspect-preserving fit of a srcW x srcH frame into a dst x dst square,
 * centered. 192x208 → 236x256 at dst 256 (height fills, pillarboxed).
 */
export function fitFrame(srcWidth, srcHeight, dst) {
  const scale = Math.min(dst / srcWidth, dst / srcHeight)
  const width = Math.max(1, Math.round(srcWidth * scale))
  const height = Math.max(1, Math.round(srcHeight * scale))
  return {
    width,
    height,
    offsetX: Math.floor((dst - width) / 2),
    offsetY: Math.floor((dst - height) / 2),
  }
}
