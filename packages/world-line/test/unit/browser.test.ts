/**
 * Phase 3 browser probe unit tests: the whole browser layer is faked through
 * the deps injection surface (Browser/Context/Page), covering ready, fail
 * (console/page/request errors), inconclusive (markers never reached, probe
 * crash), no-browser, and the close-ownership rule (never leak a browser the
 * probe itself launched).
 */

import { describe, expect, test } from '@rstest/core'
import type {
  BrowserContextLike,
  BrowserHandleLike,
  PageLike,
  ShellState,
} from '../../src/lab/browser.js'
import { runClientProbe } from '../../src/lab/browser.js'

type Handler = (arg: unknown) => void

class FakePage implements PageLike {
  handlers: Record<string, Handler[]> = { console: [], pageerror: [], requestfailed: [] }
  states: ShellState[]
  gotoResult: unknown
  gotoError: unknown
  /** Events flushed deterministically right before the next evaluation. */
  pendingEvents: Array<['console' | 'pageerror' | 'requestfailed', unknown]> = []
  closed = false

  constructor(states: ShellState[]) {
    this.states = [...states]
  }

  async goto(): Promise<unknown> {
    if (this.gotoError !== undefined) throw this.gotoError
    return this.gotoResult
  }

  async waitForTimeout(): Promise<void> {}

  on(event: 'console' | 'pageerror' | 'requestfailed', handler: (arg: unknown) => void): void {
    ;(this.handlers[event] ??= []).push(handler)
  }

  async evaluate<T>(_fn: () => T | Promise<T>): Promise<T> {
    for (const [event, arg] of this.pendingEvents.splice(0)) {
      for (const handler of this.handlers[event] ?? []) handler(arg)
    }
    if (this.states.length > 0) return this.states.shift() as T
    return {
      mountChildren: 0,
      buttons: [],
      roles: [],
      bodyHas: [],
      bootGlobals: [],
      bootEntries: 0,
    } as T
  }

  emit(event: 'console' | 'pageerror' | 'requestfailed', arg: unknown): void {
    this.pendingEvents.push([event, arg])
  }
}

class FakeContext implements BrowserContextLike {
  page: FakePage
  constructor(page: FakePage) {
    this.page = page
  }
  async newPage(): Promise<PageLike> {
    return this.page
  }
}

class FakeBrowser implements BrowserHandleLike {
  context: FakeContext | null
  closed = false
  constructor(page: FakePage | null = null) {
    this.context = page === null ? null : new FakeContext(page)
  }
  async newContext(): Promise<BrowserContextLike> {
    if (this.context === null) throw new Error('no context available')
    return this.context
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

function readyState(): ShellState {
  return {
    mountChildren: 1,
    buttons: ['新会话', '设置'],
    roles: ['tree'],
    bodyHas: ['暂无会话', '工作区', '新会话', '设置', '选择一个工作区开始'],
    bootGlobals: ['__DSH_BOOT__', '__DSH_BOOT_READY__'],
    bootEntries: 2,
  }
}

function emptyState(): ShellState {
  return {
    mountChildren: 0,
    buttons: [],
    roles: [],
    bodyHas: [],
    bootGlobals: [],
    bootEntries: 0,
  }
}

describe('browser client probe', () => {
  test('reports ready once the shell markers settle without errors', async () => {
    const page = new FakePage([emptyState(), readyState()])
    const browser = new FakeBrowser(page)
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 500,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    if (outcome.signal.kind === 'ready') {
      expect(outcome.signal.settledMs).toBeGreaterThanOrEqual(0)
      expect(outcome.signal.state.bootEntries).toBe(2)
    }
    // Injected browsers belong to the caller: never closed by the probe.
    expect(browser.closed).toBe(false)
  })

  test('a console error turns a settled shell into a fail', async () => {
    const page = new FakePage([readyState(), readyState()])
    const browser = new FakeBrowser(page)
    page.emit('console', { type: () => 'error', text: () => 'boom at runtime' })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('fail')
    if (outcome.signal.kind === 'fail') {
      expect(outcome.signal.errors.join()).toContain('boom at runtime')
    }
    expect(outcome.events.some((entry) => entry.startsWith('console.error'))).toBe(true)
  })

  test('a pageerror is recorded as a client failure', async () => {
    const page = new FakePage([readyState()])
    const browser = new FakeBrowser(page)
    page.emit('pageerror', 'uncaught reference')
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('fail')
    expect(outcome.events.some((entry) => entry.startsWith('pageerror:'))).toBe(true)
  })

  test('failed same-origin plugin/api/sse requests count against the boot', async () => {
    const page = new FakePage([readyState(), readyState()])
    const browser = new FakeBrowser(page)
    page.emit('requestfailed', {
      url: () => 'http://127.0.0.1:1/plugins/x?token=secret',
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
    })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('fail')
    expect(outcome.events.some((entry) => entry.startsWith('requestfailed:'))).toBe(true)
  })

  test('markers missing without errors is inconclusive, not ready', async () => {
    const page = new FakePage([emptyState(), emptyState()])
    const browser = new FakeBrowser(page)
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('inconclusive')
  })

  test('no browser executable yields a no-browser signal', async () => {
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      deps: { launch: async () => null },
    })
    expect(outcome.signal.kind).toBe('no-browser')
  })

  test('a crashed probe is inconclusive', async () => {
    const browser = new FakeBrowser(null)
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('inconclusive')
    if (outcome.signal.kind === 'inconclusive') {
      expect(outcome.signal.reason).toContain('no context available')
    }
  })

  test('a browser the probe itself launched is always closed again', async () => {
    const page = new FakePage([readyState()])
    const browser = new FakeBrowser(page)
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { launch: async () => browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(browser.closed).toBe(true)
  })

  test('a goto failure is inconclusive, never a crash of the CLI', async () => {
    const page = new FakePage([])
    page.gotoError = new Error('connection refused')
    const browser = new FakeBrowser(page)
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('inconclusive')
  })
})
