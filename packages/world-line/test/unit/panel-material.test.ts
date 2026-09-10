import { readFileSync } from 'node:fs'
import { expect, test } from '@rstest/core'
import { panelMaterialStyles } from '../../src/client/panel-material.js'
import { styles } from '../../src/client/styles.js'

test('panel layout cannot reintroduce an opaque surface or disable backdrop filtering', () => {
  const source = readFileSync(new URL('../../src/client/styles.ts', import.meta.url), 'utf8')
  const conflicts: string[] = []
  for (const [, rawSelector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector!.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    const root =
      /^(?:\.wl-page )?\.wl-(?:panel|inspector|dialog)$/.test(selector) ||
      /^\.wl-page :is\([^()]*\.wl-(?:panel|inspector|dialog)[^()]*\)(?:,\.wl-hud-tooltip)?$/.test(
        selector,
      )
    if (
      root &&
      /(?:^|;)(?:background(?:-color|-image)?|(?:-webkit-)?backdrop-filter|box-shadow):/.test(body!)
    )
      conflicts.push(selector)
  }
  expect(conflicts).toEqual([])
  expect(styles.split(panelMaterialStyles)).toHaveLength(2)
})

test('glass keeps tint separate from content opacity and has a browser fallback', () => {
  expect(panelMaterialStyles).toContain('transparent')
  expect(panelMaterialStyles).toContain('-webkit-backdrop-filter:var(--wl-panel-blur)')
  expect(panelMaterialStyles).toContain('@supports not')
  expect(panelMaterialStyles).not.toMatch(/(?:^|[;{])opacity:/)
})
