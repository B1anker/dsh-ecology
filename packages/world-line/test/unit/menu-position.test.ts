import { describe, expect, test } from '@rstest/core'
import { menuPosition } from '../../src/client/menu-position.js'

const bounds = { left: 288, top: 8, right: 1504, bottom: 798 }
const size = { width: 244, height: 240 }
describe('world line floating menu boundaries', () => {
  test('opens right near the left edge and left near the right edge', () => {
    expect(menuPosition({ left: 300, right: 300, top: 100 }, size, bounds)).toEqual({
      left: 300,
      top: 100,
      flipped: false,
    })
    expect(menuPosition({ left: 1490, right: 1490, top: 100 }, size, bounds)).toEqual({
      left: 1246,
      top: 100,
      flipped: true,
    })
  })
  test('submenus flip independently using their parent row and avoid the bottom edge', () => {
    expect(menuPosition({ left: 1250, right: 1494, top: 750 }, size, bounds, true)).toEqual({
      left: 1002,
      top: 558,
      flipped: true,
    })
    expect(menuPosition({ left: 300, right: 544, top: 100 }, size, bounds, true)).toEqual({
      left: 548,
      top: 100,
      flipped: false,
    })
  })
  test('clamps every position to the canvas viewport, including small screens', () => {
    for (const area of [bounds, { left: 8, top: 8, right: 382, bottom: 836 }]) {
      for (const x of [-100, 8, 300, 1400, 2000])
        for (const y of [-100, 400, 1000]) {
          const placed = menuPosition({ left: x, right: x, top: y }, size, area)
          expect(placed.left).toBeGreaterThanOrEqual(area.left)
          expect(placed.top).toBeGreaterThanOrEqual(area.top)
          expect(placed.left + size.width).toBeLessThanOrEqual(area.right)
          expect(placed.top + size.height).toBeLessThanOrEqual(area.bottom)
        }
    }
  })
})
