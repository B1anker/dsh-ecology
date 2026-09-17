/**
 * The two sides of the bridge contract are written in two languages, so no
 * type checker sees both. These tests read the desktop app's source and pin
 * the values the plugin hard-codes against it: the loopback port and the
 * environment variable naming the origins the bridge may grant.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from '@rstest/core'
import { DESKTOP_COMPANION_PORT } from '../src/client/bridge.js'
import { DESKTOP_BRIDGE_PORT } from '../src/desktop.js'
import { BRIDGE_ORIGINS_ENV } from '../src/launch.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopSrc = join(here, '..', '..', 'pet-desktop', 'src')

describe('desktop bridge contract', () => {
  test('the plugin dials the port the app listens on', () => {
    const server = readFileSync(join(desktopSrc, 'server.zig'), 'utf8')
    const declared = /pub const port: u16 = (\d+);/.exec(server)
    expect(declared?.[1]).toBeDefined()
    expect(Number(declared?.[1])).toBe(DESKTOP_BRIDGE_PORT)
    // The browser bundle has no second copy of the number.
    expect(DESKTOP_COMPANION_PORT).toBe(DESKTOP_BRIDGE_PORT)
  })

  test('the launcher names the allow-list variable the app reads', () => {
    const origin = readFileSync(join(desktopSrc, 'origin.zig'), 'utf8')
    const declared = /pub const env_name = "([A-Z_]+)";/.exec(origin)
    expect(declared?.[1]).toBe(BRIDGE_ORIGINS_ENV)
  })
})
