/**
 * RasterPet: renders an imported bitmap pet as a stepped CSS sprite animation.
 *
 * The plugin itself renders nothing on the page except the settings panel, so
 * this component exists for the panel's appearance picker previews. The
 * desktop app is the real display surface; here the same sprite strips serve
 * as thumbnails.
 *
 * The rendering is the classic CSS sprite trick: one horizontal strip of
 * square frames per mood, sized `frames` times the box width; keyframes sweep
 * `background-position-x` from 0 to a full strip width while `steps(frames)`
 * jumps one frame per step — the final offset is the loop point and is never
 * held, so exactly frames 0..n-1 show.
 *
 * The keyframes carry pixel offsets, which depend on the display size, so the
 * rule is generated per (pet, mood, size) and injected next to the element.
 * Playback sits behind `prefers-reduced-motion`: a user who asked for
 * stillness gets the strip's first frame.
 *
 * @module @seaveyon/dsh-pet/client/raster-pet
 */

import type { DesktopPet } from './bridge.js'
import type { Mood } from './mood.js'

export interface RasterPetProps {
  pet: DesktopPet
  mood: Mood
  /** Display edge length in pixels; frames are square, so height matches. */
  size: number
}

/** A CSS-identifier-safe keyframes/class name for one (pet, mood, size). */
export function rasterAnimationName(petId: string, mood: Mood, frames: number, size: number) {
  const safePet = petId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `dsh-pet-raster-${safePet}-${mood}-${frames}f-${Math.round(size * 10)}`
}

export function RasterPet({ pet, mood, size }: RasterPetProps) {
  const sprite = pet.moods[mood]
  const name = rasterAnimationName(pet.id, mood, sprite.frames, size)
  const durationMs = sprite.frames * sprite.frameDurationMs
  const css =
    `@keyframes ${name} { from { background-position-x: 0; } ` +
    `to { background-position-x: -${sprite.frames * size}px; } }\n` +
    `@media (prefers-reduced-motion: no-preference) {\n` +
    `  .${name} { animation: ${name} ${durationMs}ms steps(${sprite.frames}) infinite; }\n` +
    `}`
  return (
    <div
      data-dsh-pet-raster=""
      data-pet-id={pet.id}
      data-mood={mood}
      role="img"
      aria-hidden="true"
      className={name}
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        backgroundImage: `url("${sprite.url}")`,
        backgroundSize: `${sprite.frames * 100}% 100%`,
        backgroundRepeat: 'no-repeat',
      }}
    >
      <style>{css}</style>
    </div>
  )
}
