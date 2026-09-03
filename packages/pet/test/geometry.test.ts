/**
 * Viewport clamping: the edges are the whole point.
 */

import { expect, test } from '@rstest/core'
import { clampPosition } from '../src/client/geometry.js'

test('positions inside the viewport pass through', () => {
  expect(clampPosition(100, 200, 64, 1024, 768)).toEqual({ x: 100, y: 200 })
})

test('negative coordinates clamp to the origin', () => {
  expect(clampPosition(-10, -1, 64, 1024, 768)).toEqual({ x: 0, y: 0 })
})

test('coordinates beyond the far edge clamp so the pet stays fully visible', () => {
  expect(clampPosition(2000, 2000, 64, 1024, 768)).toEqual({ x: 960, y: 704 })
})

test('a viewport smaller than the pet collapses to the origin', () => {
  expect(clampPosition(50, 50, 64, 30, 30)).toEqual({ x: 0, y: 0 })
})
