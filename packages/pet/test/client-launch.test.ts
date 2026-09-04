/**
 * The client half of the launcher: loopback detection (the button's display
 * gate) and requestDesktopLaunch's status mapping — a JSON not_installed 404
 * is "go download", while any other failure shape (including a route-less
 * older host's HTML 404) is "the host could not help".
 */

import { describe, expect, test } from '@rstest/core'
import { isLoopbackHost, LAUNCH_DESKTOP_PATH, requestDesktopLaunch } from '../src/client/launch.js'

describe('isLoopbackHost', () => {
  test('loopback spellings pass', () => {
    for (const host of ['localhost', 'dsh.localhost', '127.0.0.1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  test('LAN and public hosts do not', () => {
    for (const host of ['192.168.1.10', 'dsh.internal', 'example.com', '::1']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('requestDesktopLaunch', () => {
  test('POSTs the route same-origin with the mandatory header', async () => {
    let seen: { url: unknown; init: RequestInit | undefined } | undefined
    const fetchFn = ((url: unknown, init?: RequestInit) => {
      seen = { url, init }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }) as unknown as typeof fetch

    const result = await requestDesktopLaunch({ fetchFn })

    expect(result).toBe('launched')
    expect(seen?.url).toBe(LAUNCH_DESKTOP_PATH)
    expect(seen?.init?.method).toBe('POST')
    expect(seen?.init?.credentials).toBe('same-origin')
    expect(new Headers(seen?.init?.headers).get('x-dsh-pet-launch')).toBe('1')
  })

  test("the launcher's JSON 404 means not-installed", async () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: 'not_installed' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch
    expect(await requestDesktopLaunch({ fetchFn })).toBe('not-installed')
  })

  test('a route-less host answers 404 too, but not in JSON — that is unavailable', async () => {
    const fetchFn = (() =>
      Promise.resolve(
        new Response('<html><body>not found</body></html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
      )) as unknown as typeof fetch
    expect(await requestDesktopLaunch({ fetchFn })).toBe('unavailable')
  })

  test('other statuses and network failure are unavailable, never a throw', async () => {
    const fiveHundred = (() =>
      Promise.resolve(new Response('oops', { status: 500 }))) as unknown as typeof fetch
    expect(await requestDesktopLaunch({ fetchFn: fiveHundred })).toBe('unavailable')

    const dead = (() => Promise.reject(new Error('connection reset'))) as unknown as typeof fetch
    expect(await requestDesktopLaunch({ fetchFn: dead })).toBe('unavailable')
  })
})
