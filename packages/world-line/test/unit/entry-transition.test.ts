import { describe, expect, test } from '@rstest/core'
import { EntryTransition } from '../../src/client/entry-transition.js'

describe('world-line entry handoff', () => {
  test('skipping motion never navigates until the target is ready', async () => {
    const events: string[] = []
    const entry = new EntryTransition({
      warp: () => events.push('warp'),
      navigate: (url) => events.push(url),
    })
    entry.skip()
    expect(events).toEqual([])
    expect(await entry.finish('http://127.0.0.1:4000/')).toBe(true)
    expect(events).toEqual(['http://127.0.0.1:4000/'])
  })
  test('cancelling during the initial hold prevents a late response from navigating', async () => {
    const events: string[] = []
    const entry = new EntryTransition({
      warp: () => events.push('warp'),
      navigate: () => events.push('navigate'),
    })
    const pending = entry.finish('destination')
    entry.cancel()
    expect(await pending).toBe(false)
    expect(events).toEqual([])
  })
  test('cancelling during warp prevents navigation', async () => {
    let navigated = false
    const entry = new EntryTransition({
      holdMs: 0,
      warp: () => entry.cancel(),
      navigate: () => {
        navigated = true
      },
    })
    expect(await entry.finish('destination')).toBe(false)
    expect(navigated).toBe(false)
  })
  test('a ready destination is handed off once, including reduced-motion entry', async () => {
    const events: string[] = []
    const entry = new EntryTransition({
      holdMs: 0,
      warpMs: 0,
      warp: () => events.push('warp'),
      navigate: (url) => events.push(url),
    })
    expect(await Promise.all([entry.finish('destination'), entry.finish('another')])).toEqual([
      true,
      true,
    ])
    expect(events).toEqual(['warp', 'destination'])
  })
})
