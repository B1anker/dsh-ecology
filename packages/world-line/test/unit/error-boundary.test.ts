// @rstest-environment jsdom
/**
 * The fence between the plugin's tree and the host's: a throw inside the
 * children lands in the fallback, not in the root above the boundary; the
 * fallback's reset remounts the children; the panel's crash card offers a
 * retry and a way out.
 */

import { afterEach, describe, expect, it } from '@rstest/core'
import { act, createElement, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ErrorBoundary, PanelCrash } from '../../src/client/error-boundary.js'

// React's act() warning gate; the same switch every React test harness flips.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; container: HTMLElement }[] = []

function mount(node: ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.append(container)
  // React 19 reports every contained throw as a "recoverable error" on the
  // root as well; that is noise here, the boundary's own report is asserted.
  const root = createRoot(container, { onRecoverableError: () => {} })
  act(() => {
    root.render(node)
  })
  roots.push({ root, container })
  return container
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
})

/**
 * Throws while armed. The fault has to persist across React's own retry —
 * a concurrent render that throws is re-run synchronously before the
 * boundary is consulted — so it is disarmed by the test, not by rendering.
 */
function faulty(): { Component: () => ReactNode; arm(): void; disarm(): void } {
  let armed = false
  return {
    arm: () => {
      armed = true
    },
    disarm: () => {
      armed = false
    },
    Component: () => {
      if (armed) throw new Error('canvas node without a shape')
      return createElement('span', { 'data-ok': 'true' }, 'panel')
    },
  }
}

describe('ErrorBoundary', () => {
  it('contains a render error and reports it instead of propagating it', () => {
    const reported: string[] = []
    const { Component, arm } = faulty()
    arm()
    const container = mount(
      createElement(
        ErrorBoundary,
        {
          fallback: ({ error }) => createElement('em', null, `fell back: ${error.message}`),
          onError: (error) => {
            reported.push(error.message)
          },
        },
        createElement(Component),
      ),
    )
    expect(container.textContent).toBe('fell back: canvas node without a shape')
    expect(reported).toEqual(['canvas node without a shape'])
  })

  it('remounts the children on reset', () => {
    const { Component, arm, disarm } = faulty()
    arm()
    const container = mount(
      createElement(
        ErrorBoundary,
        {
          fallback: ({ reset }) => createElement('button', { onClick: reset }, 'retry'),
          onError: () => {},
        },
        createElement(Component),
      ),
    )
    expect(container.querySelector('button')?.textContent).toBe('retry')
    // Retrying while the fault persists lands back on the fallback…
    act(() => {
      container.querySelector('button')?.click()
    })
    expect(container.querySelector('button')?.textContent).toBe('retry')
    // …and once the cause is gone, the same retry brings the child back.
    disarm()
    act(() => {
      container.querySelector('button')?.click()
    })
    expect(container.querySelector('[data-ok]')?.textContent).toBe('panel')
  })

  it('leaves siblings outside the boundary standing', () => {
    const { Component, arm } = faulty()
    arm()
    const container = mount(
      createElement(
        'div',
        null,
        createElement('nav', null, 'shell'),
        createElement(
          ErrorBoundary,
          { fallback: () => null, onError: () => {} },
          createElement(Component),
        ),
      ),
    )
    expect(container.querySelector('nav')?.textContent).toBe('shell')
    expect(container.querySelector('[data-ok]')).toBeNull()
  })

  it('turns a non-Error throw into an Error for the fallback', () => {
    const Thrower = () => {
      throw 'plain string'
    }
    const container = mount(
      createElement(
        ErrorBoundary,
        {
          fallback: ({ error }) => createElement('em', null, error.message),
          onError: () => {},
        },
        createElement(Thrower),
      ),
    )
    expect(container.textContent).toBe('plain string')
  })
})

describe('PanelCrash', () => {
  it('shows the message inside the panel frame with retry and close', () => {
    const calls: string[] = []
    const container = mount(
      createElement(PanelCrash, {
        error: new Error('boom'),
        reset: () => {
          calls.push('reset')
        },
        close: () => {
          calls.push('close')
        },
      }),
    )
    const page = container.querySelector('.wl-page.wl-crash')
    expect(page?.getAttribute('role')).toBe('alert')
    expect(container.querySelector('.wl-crash-detail')?.textContent).toBe('boom')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['重试', '关闭面板'])
    act(() => {
      buttons[0]?.click()
      buttons[1]?.click()
    })
    expect(calls).toEqual(['reset', 'close'])
  })

  it('composes with the boundary: retry remounts, close is the caller’s', () => {
    const { Component, arm } = faulty()
    arm()
    let closed = 0
    const Shell = () => {
      const [open, setOpen] = useState(true)
      if (!open) return createElement('p', null, 'back in the shell')
      return createElement(
        ErrorBoundary,
        {
          fallback: ({ error, reset }) =>
            createElement(PanelCrash, {
              error,
              reset,
              close: () => {
                closed += 1
                setOpen(false)
              },
            }),
          onError: () => {},
        },
        createElement(Component),
      )
    }
    const container = mount(createElement(Shell))
    expect(container.querySelector('.wl-crash')).not.toBeNull()
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === '关闭面板')
        ?.click()
    })
    expect(closed).toBe(1)
    expect(container.textContent).toBe('back in the shell')
  })
})
