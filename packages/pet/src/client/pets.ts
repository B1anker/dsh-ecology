/**
 * The three built-in pets: hand-drawn 64×64 SVG sprites parameterized by mood.
 *
 * Each pet is a string template rather than JSX because the settings panel
 * injects previews via `dangerouslySetInnerHTML` — one DOM subtree, no React
 * reconciliation cost per blink, and the sprites stay copy-pasteable into a
 * design tool. Eyes and mouths are shared generators (see `eyesFor`/`mouthFor`)
 * so all three pets read the same mood vocabulary; only the face geometry
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
@media (prefers-reduced-motion: no-preference) {
  .dsh-pet-mood-idle .dsh-pet-body { animation: dsh-pet-breathe 3s ease-in-out infinite alternate; }
  .dsh-pet-mood-thinking .dsh-pet-body { animation: dsh-pet-tilt 2.4s ease-in-out infinite; }
  .dsh-pet-mood-working .dsh-pet-body { animation: dsh-pet-run 0.35s ease-in-out infinite; }
  .dsh-pet-mood-waiting .dsh-pet-body { animation: dsh-pet-sway 1.6s ease-in-out infinite; }
  .dsh-pet-mood-celebrating .dsh-pet-body { animation: dsh-pet-jump 0.6s ease-out infinite; }
  .dsh-pet-mood-pet .dsh-pet-body { animation: dsh-pet-wiggle 0.5s ease-in-out infinite; }
  .dsh-pet-mood-sleeping .dsh-pet-body { animation: dsh-pet-sleep 2.4s ease-in-out infinite alternate; }
  .dsh-pet-mood-sleeping .dsh-pet-zzz text { animation: dsh-pet-zzz 2.4s linear infinite; }
  .dsh-pet-mood-sleeping .dsh-pet-zzz text:nth-child(2) { animation-delay: 1.2s; }
  .dsh-pet-svg .dsh-pet-blink { animation: dsh-pet-blink 4.2s ease-in-out infinite; }
}
`
