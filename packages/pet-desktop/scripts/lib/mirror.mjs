/**
 * Horizontal mirror of a sprite strip, frame by frame: every frame is
 * flipped within its own frame-width slice, so frame ORDER stays
 * left-to-right and the mirrored strip is a drop-in replacement for the
 * original (same geometry, same crop math in src/model.zig).
 *
 * Exists because the zero-native SDK's software reference renderer
 * (packages/pet-desktop/zig-pkg/.../src/primitives/canvas/reference.zig
 * drawImage) applies an Affine via transformRect's axis-aligned bounding
 * box, which drops the sign of a negative scale — and Windows transparent
 * windows always render through that path. The app therefore mirrors the
 * run strip ahead of time instead of at draw time.
 */

import { decodePng, encodePng } from './png.mjs'

/**
 * Mirror one decoded strip ({ width, height, data } as decodePng returns)
 * horizontally, frame by frame. `frames` is the manifest's frame count;
 * the strip width must divide evenly into that many frames.
 */
export function mirrorStrip({ width, height, data }, frames) {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`invalid frame count ${frames}`)
  }
  if (width % frames !== 0) {
    throw new Error(`strip width ${width} does not divide into ${frames} frames`)
  }
  const frameWidth = width / frames
  const out = Buffer.alloc(data.length)
  for (let y = 0; y < height; y++) {
    for (let f = 0; f < frames; f++) {
      for (let x = 0; x < frameWidth; x++) {
        const s = (y * width + f * frameWidth + x) * 4
        const d = (y * width + f * frameWidth + (frameWidth - 1 - x)) * 4
        out[d] = data[s]
        out[d + 1] = data[s + 1]
        out[d + 2] = data[s + 2]
        out[d + 3] = data[s + 3]
      }
    }
  }
  return { width, height, data: out }
}

/** Decode → mirrorStrip → encode, for callers holding an encoded PNG. */
export function mirrorPngBytes(pngBytes, frames) {
  return encodePng(mirrorStrip(decodePng(pngBytes), frames))
}
