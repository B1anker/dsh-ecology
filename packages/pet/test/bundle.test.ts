/**
 * The built client bundle, exercised as the shell would exercise it.
 *
 * Testing `src/` proves the source; this proves the artifact — the
 * `__ModuleLoader__` envelope the build wraps it in, the external `react`
 * reference the shell's module table answers, and the slot registration that
 * is the whole point of the bundle. A wrapper regression (wrong banner, lost
 * export, renamed entry) fails here before it fails in a browser.
 */

import { readFileSync } from 'node:fs'
import { expect, test } from '@rstest/core'
import { createMockClientRuntime } from '@seaveyon/dsh-plugin-testkit'
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'

function loadBundle() {
  const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  const runtime = createMockClientRuntime({
    modules: { react: React, 'react/jsx-runtime': ReactJsxRuntime },
  })
  const shell: Record<string, unknown> = {}
  runtime.loader.install(shell)
  // The bundle's only global touch is `window.__ModuleLoader__.load(...)`.
  new Function('window', source)(shell)
  return runtime
}

test('the bundle announces itself to the module loader', () => {
  const runtime = loadBundle()
  expect(runtime.loader.loaded?.id).toBe('@seaveyon/dsh-pet')

  const exports = runtime.loader.invokeFactory()
  expect(exports.name).toBe('@seaveyon/dsh-pet')
  expect(exports.inject).toContain('slots')
  expect(typeof exports.apply).toBe('function')
})

test('apply registers the overlay slot contribution', () => {
  const runtime = loadBundle()
  const exports = runtime.loader.invokeFactory()
  exports.apply?.(runtime.context)

  const overlays = runtime.slots.registrations.get('shell.overlay')
  expect(overlays).toHaveLength(1)
  expect(overlays?.[0]?.descriptor['id']).toBe('dsh-pet')
})
