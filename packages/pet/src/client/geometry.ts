/**
 * Viewport clamping for the dragged pet.
 *
 * Kept tiny and pure because it is the one piece of drag logic that is easy
 * to get wrong at the edges (pet larger than the viewport, negative origins)
 * and the drag handler has enough going on without inline math.
 *
 * @module @seaveyon/dsh-pet/client/geometry
 */

export interface Position {
  x: number
  y: number
}

/**
 * Clamp a pet box of `size`×`size` pixels so it stays fully inside the
 * viewport. A viewport smaller than the pet collapses to the origin rather
 * than producing a negative range that would ping-pong the position.
 */
export function clampPosition(
  x: number,
  y: number,
  size: number,
  viewportW: number,
  viewportH: number,
): Position {
  const maxX = Math.max(0, viewportW - size)
  const maxY = Math.max(0, viewportH - size)
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  }
}
