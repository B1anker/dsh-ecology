// @rstest-environment jsdom
import { describe, expect, it } from '@rstest/core'
import { findMountHost } from '../src/client-anchor.js'

/**
 * A hero row the way the 0.1.5 conversation shell renders it: CSS-module
 * classes with the source name kept as a suffix, the workspace chip, then the
 * agent-preset seat whose label is whatever preset is selected.
 */
function renderHero(presetLabel: string): { row: HTMLElement; seatParent: HTMLElement } {
  document.body.innerHTML = `
    <div class="wSkVaW_hero">
      <div class="wSkVaW_heroWorkspaceRow">
        <button type="button" class="wSkVaW_chip">dsh-ecology</button>
        <div class="cubgiG_menuAnchor">
          <button type="button" class="cubgiG_seat" aria-haspopup="menu">
            <span class="cubgiG_seatLabel">${presetLabel}</span>
          </button>
        </div>
      </div>
    </div>`
  const row = document.querySelector<HTMLElement>('.wSkVaW_heroWorkspaceRow')
  const seatParent = document.querySelector<HTMLElement>('.cubgiG_menuAnchor')
  if (row === null || seatParent === null) throw new Error('fixture did not render')
  return { row, seatParent }
}

describe('findMountHost', () => {
  it('mounts on the hero row whatever preset is selected and whichever locale runs', () => {
    for (const label of [
      '标准模式',
      'Standard mode',
      'PTC 模式',
      'Minimal mode',
      'my-own-preset',
    ]) {
      const { row } = renderHero(label)
      expect(findMountHost(document), label).toBe(row)
    }
  })

  it('survives a rebuild that changes the class hash', () => {
    renderHero('标准模式')
    const row = document.querySelector<HTMLElement>('.wSkVaW_heroWorkspaceRow')
    row?.setAttribute('class', 'Q9x2kd_heroWorkspaceRow')
    expect(findMountHost(document)).toBe(row)
  })

  it('falls back to the seat label on a host whose row carries no such class', () => {
    const { row, seatParent } = renderHero('Standard mode')
    row.removeAttribute('class')
    expect(findMountHost(document)).toBe(seatParent)
  })

  it('reports no host when the hero is not on screen', () => {
    document.body.innerHTML = `
      <header><button type="button">Settings</button></header>
      <main><div class="session">transcript</div></main>`
    expect(findMountHost(document)).toBeUndefined()
  })
})
