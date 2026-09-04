/**
 * The four built-in pets: hand-drawn 64×64 SVG sprites parameterized by mood.
 *
 * Each pet is a string template rather than JSX because the settings panel
 * injects previews via `dangerouslySetInnerHTML` — one DOM subtree, no React
 * reconciliation cost per blink, and the sprites stay copy-pasteable into a
 * design tool. Eyes and mouths are shared generators (see `eyesFor`/`mouthFor`)
 * so all four pets read the same mood vocabulary; only the face geometry
 * differs.
 *
 * All motion lives in {@link PET_STYLE_CSS} as CSS keyframes scoped to the
 * `dsh-pet-` prefix, and every animation sits behind
 * `@media (prefers-reduced-motion: no-preference)` — a user who asked the OS
 * for stillness gets a still pet, not a slowed one.
 *
 * Colors reference the shell's `--dsw-*` tokens with hard-coded fallbacks, so
 * the pets theme with the host where the tokens exist and stay legible where
 * they don't.
 *
 * @module @seaveyon/dsh-pet/client/pets
 */

import type { Locale } from './i18n.js'
import type { Mood } from './mood.js'

const INK = 'var(--dsw-color-text, #33363f)'
const BLUSH = 'var(--dsw-color-danger, #ff8fa3)'

/** One eye, in the shape this mood wears. */
function eyeFor(mood: Mood, x: number, y: number): string {
  const stroke = `stroke="${INK}" stroke-width="1.8" stroke-linecap="round" fill="none"`
  switch (mood) {
    case 'celebrating':
    case 'pet':
      // ^^ — joy scrunches the eyes shut.
      return `<path d="M ${x - 3} ${y + 1} Q ${x} ${y - 3.5} ${x + 3} ${y + 1}" ${stroke}/>`
    case 'sleeping':
      // A soft downward curve reads as peaceful where a straight line reads as dead.
      return `<path d="M ${x - 3} ${y} Q ${x} ${y + 2.5} ${x + 3} ${y}" ${stroke}/>`
    case 'sad':
      // Drooping lids: an arc that sags in the middle, mirrored from the happy one.
      return `<path d="M ${x - 3} ${y - 1.5} Q ${x} ${y + 2} ${x + 3} ${y - 1.5}" ${stroke}/>`
    case 'thinking':
      // Eyes drift up, as if reading the thought.
      return `<circle cx="${x}" cy="${y - 1.2}" r="2.6" fill="${INK}"/>`
    default:
      return `<circle cx="${x}" cy="${y}" r="2.6" fill="${INK}"/>`
  }
}

/**
 * Both eyes. Open dot eyes get the `dsh-pet-blink` class so the stylesheet
 * can scale them shut a few times a minute; closed-eye moods skip it because
 * blinking an already-closed eye is just noise.
 */
function eyesFor(mood: Mood, lx: number, rx: number, y: number): string {
  const blink = mood === 'idle' || mood === 'working' || mood === 'waiting' || mood === 'thinking'
  return `<g data-mood-parts="eyes" class="${blink ? 'dsh-pet-blink' : ''}">${eyeFor(mood, lx, y)}${eyeFor(mood, rx, y)}</g>`
}

/** The mouth, same vocabulary as the eyes. */
function mouthFor(mood: Mood, cx: number, cy: number): string {
  const stroke = `stroke="${INK}" stroke-width="1.8" stroke-linecap="round" fill="none"`
  switch (mood) {
    case 'celebrating':
    case 'pet':
      // Open grin: a filled D so it reads at 64px where a stroked arc wouldn't.
      return `<path d="M ${cx - 4} ${cy - 0.5} Q ${cx} ${cy + 6.5} ${cx + 4} ${cy - 0.5} Z" fill="${INK}"/>`
    case 'sad':
      return `<path d="M ${cx - 3} ${cy + 1.5} Q ${cx} ${cy - 2} ${cx + 3} ${cy + 1.5}" ${stroke}/>`
    case 'sleeping':
      // Barely-there mouth; the face is doing something else.
      return `<circle cx="${cx}" cy="${cy}" r="0.9" fill="${INK}"/>`
    case 'thinking':
      return `<circle cx="${cx}" cy="${cy + 1}" r="1.6" fill="${INK}"/>`
    case 'working':
      // Determined flat line.
      return `<path d="M ${cx - 2.5} ${cy + 1} L ${cx + 2.5} ${cy + 1}" ${stroke}/>`
    case 'waiting':
      // "…" — the universal glyph for your move.
      return `<g fill="${INK}"><circle cx="${cx - 4}" cy="${cy}" r="0.9"/><circle cx="${cx}" cy="${cy}" r="0.9"/><circle cx="${cx + 4}" cy="${cy}" r="0.9"/></g>`
    default:
      return `<path d="M ${cx - 3} ${cy} Q ${cx} ${cy + 3} ${cx + 3} ${cy}" ${stroke}/>`
  }
}

/** Blush appears only in the two openly-affectionate moods. */
function blushFor(mood: Mood, lx: number, rx: number, y: number): string {
  if (mood !== 'celebrating' && mood !== 'pet') return ''
  return `<g fill="${BLUSH}" opacity="0.55"><ellipse cx="${lx}" cy="${y}" rx="3" ry="1.8"/><ellipse cx="${rx}" cy="${y}" rx="3" ry="1.8"/></g>`
}

/** Floating "Z"s, rendered only while sleeping; the CSS floats them up and out. */
function zzzFor(mood: Mood): string {
  if (mood !== 'sleeping') return ''
  return `<g class="dsh-pet-zzz" fill="${INK}" font-size="9" font-weight="bold" font-family="sans-serif"><text x="44" y="16">Z</text><text x="50" y="22">z</text></g>`
}

function wrap(id: string, mood: Mood, body: string): string {
  return `<svg viewBox="0 0 64 64" class="dsh-pet-svg dsh-pet-mood-${mood}" data-pet-id="${id}" data-mood="${mood}" role="img" aria-hidden="true">${body}${zzzFor(mood)}</svg>`
}

function blobSvg(mood: Mood): string {
  const body = 'var(--dsw-color-primary, #4b6bfb)'
  const shade = 'var(--dsw-color-primary-active, #3a55d9)'
  return wrap(
    'blob',
    mood,
    `<g class="dsh-pet-body">` +
      // A jelly blob: round with a slightly flattened, wobbling base.
      `<path d="M32 10 C 44 10 52 20 52 33 C 52 45 45 52 32 52 C 19 52 12 45 12 33 C 12 20 20 10 32 10 Z" fill="${body}"/>` +
      `<ellipse cx="32" cy="49" rx="14" ry="4" fill="${shade}" opacity="0.5"/>` +
      // A highlight sells the jelly better than any shading gradient.
      `<ellipse cx="24" cy="20" rx="6" ry="4" fill="#fff" opacity="0.35" transform="rotate(-20 24 20)"/>` +
      eyesFor(mood, 24, 40, 31) +
      mouthFor(mood, 32, 38) +
      blushFor(mood, 19, 45, 36) +
      `</g>`,
  )
}

function catSvg(mood: Mood): string {
  const fur = 'var(--dsw-color-warning, #f2a54a)'
  const furDark = 'var(--dsw-color-warning-active, #d98e2b)'
  return wrap(
    'cat',
    mood,
    `<g class="dsh-pet-body">` +
      // Tail first so the head overlaps its root.
      `<path d="M46 46 C 56 46 58 34 52 30" stroke="${furDark}" stroke-width="4" stroke-linecap="round" fill="none"/>` +
      // Ears: inner triangles slightly inset, pink center.
      `<path d="M18 24 L 16 8 L 30 16 Z" fill="${fur}"/>` +
      `<path d="M46 24 L 48 8 L 34 16 Z" fill="${fur}"/>` +
      `<path d="M20 20 L 19 12 L 26 16 Z" fill="${BLUSH}" opacity="0.6"/>` +
      `<path d="M44 20 L 45 12 L 38 16 Z" fill="${BLUSH}" opacity="0.6"/>` +
      // Head.
      `<circle cx="32" cy="34" r="17" fill="${fur}"/>` +
      // Muzzle patch.
      `<ellipse cx="32" cy="41" rx="7" ry="5" fill="#fff" opacity="0.5"/>` +
      eyesFor(mood, 25, 39, 32) +
      mouthFor(mood, 32, 39) +
      blushFor(mood, 19, 45, 37) +
      // Whiskers last so nothing covers them.
      `<g stroke="${INK}" stroke-width="1" stroke-linecap="round" opacity="0.6">` +
      `<path d="M12 36 L 20 37"/><path d="M12 41 L 20 40"/>` +
      `<path d="M52 36 L 44 37"/><path d="M52 41 L 44 40"/>` +
      `</g>` +
      `</g>`,
  )
}

function robotSvg(mood: Mood): string {
  const shell = 'var(--dsw-color-info, #59b8c4)'
  const shellDark = 'var(--dsw-color-info-active, #3f97a3)'
  const panel = 'var(--dsw-color-surface, #eaf6f8)'
  return wrap(
    'robot',
    mood,
    `<g class="dsh-pet-body">` +
      // Antenna with a mood-lit tip.
      `<path d="M32 16 L 32 8" stroke="${shellDark}" stroke-width="2" stroke-linecap="round"/>` +
      `<circle cx="32" cy="7" r="2.5" fill="${mood === 'working' ? BLUSH : shellDark}"/>` +
      // Ear bolts.
      `<rect x="11" y="26" width="5" height="10" rx="2" fill="${shellDark}"/>` +
      `<rect x="48" y="26" width="5" height="10" rx="2" fill="${shellDark}"/>` +
      // Head shell with an inset face panel so the eyes sit on a screen.
      `<rect x="14" y="16" width="36" height="28" rx="8" fill="${shell}"/>` +
      `<rect x="18" y="20" width="28" height="20" rx="5" fill="${panel}"/>` +
      eyesFor(mood, 26, 38, 30) +
      mouthFor(mood, 32, 35) +
      // Body and stubby feet.
      `<rect x="22" y="44" width="20" height="10" rx="4" fill="${shell}"/>` +
      `<rect x="25" y="54" width="5" height="4" rx="2" fill="${shellDark}"/>` +
      `<rect x="34" y="54" width="5" height="4" rx="2" fill="${shellDark}"/>` +
      `</g>`,
  )
}

/**
 * DeepSeek 酱 ("小鲸"): the brand mascot as a whale maid. The drooping fin
 * ears and the whale tail — which wags on its own keyframes while she
 * celebrates — carry the ocean; the frilled headdress, the white apron with
 * its whale crest, and the skirt frills are the maid uniform. She tosses
 * gold coins while celebrating and hugs her beloved rice bowl when petted.
 */
function deepseekChanSvg(mood: Mood): string {
  const hairDeep = 'var(--dsw-color-primary, #1e3aba)'
  const hairLight = '#3b82f6'
  const shade = '#c7c9de'
  const dress = '#262c66'
  const skin = '#ffe3d3'
  const gold = '#f5c542'
  const goldInk = '#d9a62e'
  // Gold coins burst around her only while celebrating.
  const coins =
    mood === 'celebrating'
      ? `<g class="dsh-pet-dsc-coins" fill="${gold}" stroke="${goldInk}" stroke-width="0.8">` +
        `<circle cx="12.5" cy="15.5" r="2.6"/><circle cx="12.5" cy="15.5" r="1.1" fill="none"/>` +
        `<circle cx="51" cy="12" r="2.6"/><circle cx="51" cy="12" r="1.1" fill="none"/>` +
        `<circle cx="54" cy="26.5" r="2.6"/><circle cx="54" cy="26.5" r="1.1" fill="none"/>` +
        `</g>`
      : ''
  // Her beloved rice bowl, hugged to her chest only when petted.
  const bowl =
    mood === 'pet'
      ? `<g class="dsh-pet-dsc-bowl">` +
        `<path d="M26 44 C 26 41.3 28.7 39.8 32 39.8 C 35.3 39.8 38 41.3 38 44 Z" fill="#fff" stroke="${shade}" stroke-width="0.4"/>` +
        `<path d="M24.8 44 C 25.3 49 28.3 52 32 52 C 35.7 52 38.7 49 39.2 44 Z" fill="#eef6ff" stroke="${hairLight}" stroke-width="0.8"/>` +
        `<path d="M30.6 47.9 C 30.6 47 31.4 46.4 32.4 46.5 C 33.4 46.6 34 47.3 33.8 48.1 C 33.6 48.8 32.8 49.1 32 49 L 31.4 49.6 L 31.2 48.7 C 30.8 48.5 30.6 48.2 30.6 47.9 Z" fill="${hairLight}"/>` +
        `</g>`
      : ''
  return wrap(
    'deepseek-chan',
    mood,
    `<defs>` +
      `<linearGradient id="dsh-pet-dsc-hair" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${hairDeep}"/><stop offset="1" stop-color="${hairLight}"/>` +
      `</linearGradient>` +
      `</defs>` +
      // The whale tail sits in its own `dsh-pet-body` group so the bake
      // script's per-cell delay rule reaches it; in celebrating the tail-wag
      // rule (later in the stylesheet, same specificity) overrides the body
      // jump and lets it sway from its base.
      `<g class="dsh-pet-body dsh-pet-dsc-tail">` +
      `<path d="M41 53 C 47 53 52 50 53.5 45.5 L 56.5 47.5 C 55.5 52.5 50 56 42.5 56.5 Z" fill="${hairLight}"/>` +
      `<path d="M52.5 46.5 C 52.5 42.5 55 40 58 40 C 57.3 42 57.2 43.5 57.8 45 C 59.5 44.3 61 44.8 61.8 46.2 C 60 47.8 57 48 54.8 47.3 Z" fill="${hairLight}"/>` +
      `</g>` +
      `<g class="dsh-pet-body">` +
      // Back hair: one long mass, curl notches along the bottom edge.
      `<path d="M32 10 C 44.5 10 51 18.5 51 29 C 51 37 52.5 43 55 48 C 52 49.5 49.5 48.8 48 46.5 C 47.5 48.5 45.5 49.5 43 48.5 L 21 48.5 C 18.5 49.5 16.5 48.5 16 46.5 C 14.5 48.8 12 49.5 9 48 C 11.5 43 13 37 13 29 C 13 18.5 19.5 10 32 10 Z" fill="url(#dsh-pet-dsc-hair)"/>` +
      // Whale fin ears, drooping at the temples, shade-colored inside.
      `<g class="dsh-pet-dsc-ears">` +
      `<path d="M18 23 C 12.5 24 9 28.5 9.8 34.3 C 10.2 37 12.5 37.8 14.2 36.3 C 16.3 34.4 17.6 29.6 18 25.5 Z" fill="${hairDeep}"/>` +
      `<path d="M46 23 C 51.5 24 55 28.5 54.2 34.3 C 53.8 37 51.5 37.8 49.8 36.3 C 47.7 34.4 46.4 29.6 46 25.5 Z" fill="${hairDeep}"/>` +
      `<path d="M15.6 26 C 12.8 27.2 11.2 30.3 11.7 33.8 C 13.4 32.6 14.9 29.4 15.6 26 Z" fill="${shade}"/>` +
      `<path d="M48.4 26 C 51.2 27.2 52.8 30.3 52.3 33.8 C 50.6 32.6 49.1 29.4 48.4 26 Z" fill="${shade}"/>` +
      `</g>` +
      // Maid dress: puff sleeves, bodice, flared skirt.
      `<circle cx="23.5" cy="40.5" r="2.8" fill="${dress}"/>` +
      `<circle cx="40.5" cy="40.5" r="2.8" fill="${dress}"/>` +
      `<path d="M25.5 38.5 C 24 41 23 43.5 22.5 46 L 41.5 46 C 41 43.5 40 41 38.5 38.5 C 35.5 40 28.5 40 25.5 38.5 Z" fill="${dress}"/>` +
      `<path d="M22.5 45.5 C 19.5 48.5 17.3 51.5 16.3 54.3 C 24.5 56.3 39.5 56.3 47.7 54.3 C 46.7 51.5 44.5 48.5 41.5 45.5 Z" fill="${dress}"/>` +
      // Frilled skirt hem and the little bows on the skirt.
      `<g fill="#fff" stroke="${shade}" stroke-width="0.5">` +
      `<circle cx="19.5" cy="53.8" r="1.7"/><circle cx="23.5" cy="54.7" r="1.7"/><circle cx="27.7" cy="55.2" r="1.7"/><circle cx="32" cy="55.4" r="1.7"/><circle cx="36.3" cy="55.2" r="1.7"/><circle cx="40.5" cy="54.7" r="1.7"/><circle cx="44.5" cy="53.8" r="1.7"/>` +
      `</g>` +
      `<g fill="${hairLight}">` +
      `<path d="M21 50.5 L 18.6 49.1 L 18.6 51.9 Z"/><path d="M21 50.5 L 23.4 49.1 L 23.4 51.9 Z"/><circle cx="21" cy="50.5" r="0.8"/>` +
      `<path d="M43 50.5 L 40.6 49.1 L 40.6 51.9 Z"/><path d="M43 50.5 L 45.4 49.1 L 45.4 51.9 Z"/><circle cx="43" cy="50.5" r="0.8"/>` +
      `</g>` +
      // White apron with the DeepSeek whale crest.
      `<g class="dsh-pet-dsc-apron">` +
      `<rect x="25.5" y="43.5" width="13" height="2.2" rx="1" fill="#fff"/>` +
      `<path d="M26.5 45.5 C 25.3 48.5 24.8 50.8 24.8 52.3 C 28.5 53.8 35.5 53.8 39.2 52.3 C 39.2 50.8 38.7 48.5 37.5 45.5 Z" fill="#fff" stroke="${shade}" stroke-width="0.5"/>` +
      `<g fill="#fff" stroke="${shade}" stroke-width="0.4">` +
      `<circle cx="27.5" cy="52.6" r="0.9"/><circle cx="30.5" cy="53.2" r="0.9"/><circle cx="33.5" cy="53.2" r="0.9"/><circle cx="36.5" cy="52.6" r="0.9"/>` +
      `</g>` +
      `<path d="M29.2 48.9 C 29.2 47.6 30.4 46.7 31.9 46.9 C 33.4 47.1 34.3 48.2 34 49.3 C 33.8 50.2 32.6 50.7 31.3 50.5 L 30.4 51.4 L 30.1 50.1 C 29.5 49.8 29.2 49.4 29.2 48.9 Z" fill="${hairLight}"/>` +
      `<path d="M33.6 47.6 C 34.4 46.7 35.5 46.3 36.3 46.5 C 35.8 47.2 35.6 47.8 35.7 48.4 C 36.3 48.2 36.8 48.4 37.1 48.8 C 36.1 49.3 34.9 49.2 34 48.7 Z" fill="${hairLight}"/>` +
      `</g>` +
      // Face.
      `<circle cx="32" cy="28" r="11.5" fill="${skin}"/>` +
      // Bangs and the side locks framing the face.
      `<path d="M20.8 27 C 20.8 18.5 25.8 14.5 32 14.5 C 38.2 14.5 43.2 18.5 43.2 27 C 41.2 21.8 38.8 20.2 36.8 21.2 C 35.9 18.5 34 17.5 32 17.5 C 30 17.5 28.1 18.5 27.2 21.2 C 25.2 20.2 22.8 21.8 20.8 27 Z" fill="url(#dsh-pet-dsc-hair)"/>` +
      `<path d="M20.8 24 C 18.3 29.5 17.8 36 19.3 42.5 C 21 39.5 21.9 32.5 22.4 26.5 Z" fill="url(#dsh-pet-dsc-hair)"/>` +
      `<path d="M43.2 24 C 45.7 29.5 46.2 36 44.7 42.5 C 43 39.5 42.1 32.5 41.6 26.5 Z" fill="url(#dsh-pet-dsc-hair)"/>` +
      // Same glossy-hair trick as the blob's jelly highlight.
      `<ellipse cx="25" cy="15" rx="4.5" ry="2.5" fill="#fff" opacity="0.35" transform="rotate(-18 25 15)"/>` +
      // Maid headdress: a white band arcing over the hair, frilled on top.
      `<g class="dsh-pet-dsc-headdress">` +
      `<path d="M17.5 26 A 15 15 0 0 1 46.5 26" stroke="#fff" stroke-width="3" fill="none"/>` +
      `<g fill="#fff" stroke="${shade}" stroke-width="0.45">` +
      `<circle cx="17.2" cy="23.4" r="2.1"/><circle cx="20.5" cy="16.4" r="2.1"/><circle cx="26.9" cy="11.9" r="2.1"/><circle cx="32" cy="11" r="2.1"/><circle cx="37.1" cy="11.9" r="2.1"/><circle cx="43.5" cy="16.4" r="2.1"/><circle cx="46.8" cy="23.4" r="2.1"/>` +
      `</g>` +
      `</g>` +
      // The ahoge is a tiny ocean wave.
      `<path d="M31.5 8.5 C 29.5 5 31.5 1.8 34.5 2.5 C 36.8 3 37 5.8 34.8 6.2 C 33.6 6.4 32.8 5.4 33.2 4.4" stroke="${hairDeep}" stroke-width="1.7" stroke-linecap="round" fill="none"/>` +
      eyesFor(mood, 26, 38, 29) +
      mouthFor(mood, 32, 35) +
      blushFor(mood, 23.5, 40.5, 33.5) +
      coins +
      bowl +
      `</g>`,
  )
}

/** One built-in pet. */
export interface PetDefinition {
  id: string
  label: Record<Locale, string>
  /** The full sprite for a mood: a standalone `<svg>` string. */
  svg(mood: Mood): string
}

/** The built-in roster, in picker order. */
export const PETS: readonly PetDefinition[] = [
  { id: 'blob', label: { zh: '果冻团', en: 'Blob' }, svg: blobSvg },
  { id: 'cat', label: { zh: '猫猫', en: 'Cat' }, svg: catSvg },
  { id: 'robot', label: { zh: '机器人', en: 'Robot' }, svg: robotSvg },
  { id: 'deepseek-chan', label: { zh: 'DeepSeek 酱', en: 'DeepSeek-chan' }, svg: deepseekChanSvg },
]

/**
 * The stylesheet every sprite animation lives in. Rendered once by the
 * settings panel so the picker's built-in previews move.
 *
 * `transform-box: fill-box` makes each group's own bounding box the transform
 * origin, so blink/ squash pivots sit at the face instead of the SVG corner.
 */
export const PET_STYLE_CSS = `
.dsh-pet-svg { display: block; overflow: visible; width: 100%; height: 100%; }
.dsh-pet-svg .dsh-pet-body { transform-box: fill-box; transform-origin: 50% 85%; }
.dsh-pet-svg .dsh-pet-dsc-tail { transform-origin: 20% 85%; }
.dsh-pet-svg .dsh-pet-blink { transform-box: fill-box; transform-origin: center; }
@keyframes dsh-pet-blink { 0%, 93%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
@keyframes dsh-pet-breathe { from { transform: translateY(0) scale(1); } to { transform: translateY(-1.5px) scale(1.02); } }
@keyframes dsh-pet-tilt { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
@keyframes dsh-pet-run { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes dsh-pet-jump {
  0% { transform: translateY(0) scale(1, 1); }
  30% { transform: translateY(-9px) scale(0.95, 1.06); }
  55% { transform: translateY(0) scale(1.08, 0.9); }
  70% { transform: scale(0.96, 1.04); }
  100% { transform: translateY(0) scale(1, 1); }
}
@keyframes dsh-pet-wiggle { 0%, 100% { transform: rotate(-5deg); } 50% { transform: rotate(5deg); } }
@keyframes dsh-pet-sway { 0%, 100% { transform: translateX(-1.5px); } 50% { transform: translateX(1.5px); } }
@keyframes dsh-pet-sleep { from { transform: scale(1); } to { transform: scale(1.04); } }
@keyframes dsh-pet-zzz {
  0% { transform: translate(0, 0) scale(0.6); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: translate(6px, -14px) scale(1.1); opacity: 0; }
}
@keyframes dsh-pet-tail-wag { 0%, 100% { transform: rotate(-9deg); } 50% { transform: rotate(11deg); } }
@media (prefers-reduced-motion: no-preference) {
  .dsh-pet-mood-idle .dsh-pet-body { animation: dsh-pet-breathe 3s ease-in-out infinite alternate; }
  .dsh-pet-mood-thinking .dsh-pet-body { animation: dsh-pet-tilt 2.4s ease-in-out infinite; }
  .dsh-pet-mood-working .dsh-pet-body { animation: dsh-pet-run 0.35s ease-in-out infinite; }
  .dsh-pet-mood-waiting .dsh-pet-body { animation: dsh-pet-sway 1.6s ease-in-out infinite; }
  .dsh-pet-mood-celebrating .dsh-pet-body { animation: dsh-pet-jump 0.6s ease-out infinite; }
  /* DeepSeek 酱's tail wags from its base instead of jumping with the body. */
  .dsh-pet-mood-celebrating .dsh-pet-dsc-tail { animation: dsh-pet-tail-wag 0.6s ease-in-out infinite; }
  .dsh-pet-mood-pet .dsh-pet-body { animation: dsh-pet-wiggle 0.5s ease-in-out infinite; }
  .dsh-pet-mood-sleeping .dsh-pet-body { animation: dsh-pet-sleep 2.4s ease-in-out infinite alternate; }
  .dsh-pet-mood-sleeping .dsh-pet-zzz text { animation: dsh-pet-zzz 2.4s linear infinite; }
  .dsh-pet-mood-sleeping .dsh-pet-zzz text:nth-child(2) { animation-delay: 1.2s; }
  .dsh-pet-svg .dsh-pet-blink { animation: dsh-pet-blink 4.2s ease-in-out infinite; }
}
`
