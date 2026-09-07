/** Place floating menus inside the usable viewport; children prefer the parent's right edge. */
export function menuPosition(
  anchor: { left: number; right: number; top: number },
  size: { width: number; height: number },
  bounds: { left: number; top: number; right: number; bottom: number },
  child = false,
) {
  const gap = child ? 4 : 0
  const roomRight = bounds.right - anchor.right - gap
  const roomLeft = anchor.left - bounds.left - gap
  const flipped = roomRight < size.width && roomLeft > roomRight
  const x = flipped ? anchor.left - size.width - gap : anchor.right + gap
  return {
    left: Math.max(bounds.left, Math.min(x, bounds.right - size.width)),
    top: Math.max(bounds.top, Math.min(anchor.top, bounds.bottom - size.height)),
    flipped,
  }
}
