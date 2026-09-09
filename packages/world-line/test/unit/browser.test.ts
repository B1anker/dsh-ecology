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
import { closeProbeResultWindows, runClientProbe } from '../../src/lab/browser.js'

type Handler = (arg: unknown) => void

class FakePage implements PageLike {
  handlers: Record<string, Handler[]> = { console: [], pageerror: [], requestfailed: [] }
  states: ShellState[]
  gotoResult: unknown
  gotoError: unknown
  /** Events flushed deterministically right before the next evaluation. */
  pendingEvents: Array<['console' | 'pageerror' | 'requestfailed' | 'response', unknown]> = []
  closed = false

  constructor(states: ShellState[]) {
    this.states = [...states]
  }

  async goto(): Promise<unknown> {
    if (this.gotoError !== undefined) throw this.gotoError
    return this.gotoResult
  }

  async waitForTimeout(): Promise<void> {}

  on(
    event: 'console' | 'pageerror' | 'requestfailed' | 'response',
    handler: (arg: unknown) => void,
  ): void {
    ;(this.handlers[event] ??= []).push(handler)
  }

  async evaluate<T>(_fn: () => T | Promise<T>): Promise<T> {
    for (const [event, arg] of this.pendingEvents.splice(0)) {
      for (const handler of this.handlers[event] ?? []) handler(arg)
    }
    if (this.states.length > 1) return this.states.shift() as T
    if (this.states.length === 1) return this.states[0] as T
    return {
      mountChildren: 0,
      buttons: [],
      roles: [],
      bodyHas: [],
      bootGlobals: [],
      bootEntries: 0,
    } as T
  }

  emit(event: 'console' | 'pageerror' | 'requestfailed' | 'response', arg: unknown): void {
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
  test('recognizes a login gate immediately and provides an actionable result', async () => {
    const page = new FakePage([{ ...emptyState(), loginRequired: true }])
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 90_000,
      deps: { browser: new FakeBrowser(page) },
    })
    expect(outcome.signal.kind).toBe('inconclusive')
    if (outcome.signal.kind === 'inconclusive') expect(outcome.signal.reason).toContain('需要登录')
  })
  test('interactive verification waits for login and still requires the real shell', async () => {
    const page = new FakePage([{ ...emptyState(), loginRequired: true }, readyState()])
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      interactive: true,
      deps: { browser: new FakeBrowser(page) },
    })
    expect(outcome.signal.kind).toBe('ready')
  })
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

  test('a console error is diagnostic when the core shell is stable', async () => {
    const page = new FakePage([readyState(), readyState()])
    const browser = new FakeBrowser(page)
    page.emit('console', { type: () => 'error', text: () => 'boom at runtime' })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(outcome.observations?.[0]?.impact).toBe('warning')
    expect(outcome.events.some((entry) => entry.startsWith('console.error'))).toBe(true)
  })

  test('an exception with a stable shell does not block', async () => {
    const page = new FakePage([readyState()])
    const browser = new FakeBrowser(page)
    page.emit('pageerror', 'uncaught reference')
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(outcome.events.some((entry) => entry.startsWith('pageerror:'))).toBe(true)
  })

  test('failed optional same-origin resources do not override a stable core shell', async () => {
    const page = new FakePage([readyState(), readyState()])
    const browser = new FakeBrowser(page)
    page.emit('requestfailed', {
      url: () => 'http://127.0.0.1:1/plugins/x?token=secret',
      resourceType: () => 'script',
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
    })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      readyTimeoutMs: 300,
      deps: { browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(outcome.events.some((entry) => entry.startsWith('requestfailed:'))).toBe(true)
  })

  test('a shell that disappears during settling is a hard failure', async () => {
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      deps: { browser: new FakeBrowser(new FakePage([readyState(), emptyState()])) },
    })
    expect(outcome.signal.kind).toBe('fail')
  })
  test('HTTP errors are collected; external API paths are not host bundles', async () => {
    const page = new FakePage([readyState()])
    page.emit('response', {
      status: () => 503,
      url: () => 'http://127.0.0.1:2/api/state?token=secret',
      request: () => ({ resourceType: () => 'fetch' }),
    })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      deps: { browser: new FakeBrowser(page) },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(outcome.observations?.[0]).toMatchObject({
      source: 'external',
      impact: 'warning',
      address: 'http://127.0.0.1:2/api/state',
    })
    expect(JSON.stringify(outcome)).not.toContain('secret')
  })
  test('host script HTTP 404 is diagnostic if the core shell remains stable', async () => {
    const page = new FakePage([readyState()])
    page.emit('response', {
      status: () => 404,
      url: () => 'http://127.0.0.1:1/plugins/x',
      request: () => ({ resourceType: () => 'script' }),
    })
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      deps: { browser: new FakeBrowser(page) },
    })
    expect(outcome.signal.kind).toBe('ready')
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

describe('private failure artifacts', () => {
  for (const outcome of ['ready', 'fail', 'crash'] as const) {
    test(`${outcome}: tracing starts before navigation and only failures retain files`, async () => {
      const { mkdtemp, writeFile, readFile, readdir, stat, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'wl-artifacts-'))
      try {
        const calls: string[] = []
        const page = new FakePage([readyState()])
        const originalGoto = page.goto.bind(page)
        page.goto = async () => {
          calls.push('goto')
          return originalGoto()
        }
        if (outcome === 'fail') page.states = [{ ...readyState(), loaderFailed: true }]
        if (outcome === 'crash') page.gotoError = new Error('navigation failed')
        const capturingPage: PageLike = Object.assign(page, {
          screenshot: async ({ path }: { path: string }) => {
            calls.push('screenshot')
            await writeFile(path, 'PRIVATE_SCREENSHOT_BYTES')
          },
        })
        const browser: BrowserHandleLike = {
          close: async () => {
            calls.push('browser-close')
          },
          newContext: async () => ({
            close: async () => {
              calls.push('context-close')
            },
            newPage: async () => capturingPage,
            tracing: {
              start: async () => {
                calls.push('trace-start')
              },
              stop: async (options) => {
                calls.push('trace-stop')
                if (options?.path) await writeFile(options.path, 'PRIVATE_TRACE_BYTES')
              },
            },
          }),
        }
        const result = await runClientProbe({
          url: 'http://127.0.0.1:9',
          artifactContext: 'lab-verification',
          artifactRoot: root,
          deps: { browser },
        })
        expect(calls.indexOf('trace-start')).toBeLessThan(calls.indexOf('goto'))
        expect(calls).toContain('context-close')
        expect(calls).not.toContain('browser-close')
        if (outcome === 'ready') {
          expect(result.signal.kind).toBe('ready')
          expect(await readdir(root)).toEqual([])
          expect(result.artifacts).toBeUndefined()
          expect(calls).not.toContain('screenshot')
        } else {
          expect(result.signal.kind).toBe(outcome === 'fail' ? 'fail' : 'inconclusive')
          expect(result.artifacts?.files).toEqual(['failure.png', 'trace.zip'])
          expect(
            JSON.parse(await readFile(join(result.artifacts!.directory, 'index.json'), 'utf8'))
              .context,
          ).toBe('lab-verification')
          expect((await stat(result.artifacts!.directory)).mode & 0o777).toBe(0o700)
          expect((await stat(join(result.artifacts!.directory, 'trace.zip'))).mode & 0o777).toBe(
            0o600,
          )
          expect(
            await readFile(join(result.artifacts!.directory, 'index.json'), 'utf8'),
          ).not.toContain('PRIVATE_TRACE_BYTES')
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
  test('artifact recording errors do not turn a ready browser into a failure', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'wl-artifact-error-'))
    try {
      const page = new FakePage([readyState()])
      const browser: BrowserHandleLike = {
        close: async () => {},
        newContext: async () => ({
          newPage: async () => page,
          tracing: {
            start: async () => {
              throw new Error('disk failure')
            },
            stop: async () => {},
          },
        }),
      }
      expect(
        (await runClientProbe({ url: 'http://127.0.0.1:9', artifactRoot: root, deps: { browser } }))
          .signal.kind,
      ).toBe('ready')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('visible Web verification transfers its result window to bounded ownership', async () => {
  const browser = new FakeBrowser(new FakePage([readyState()]))
  try {
    const outcome = await runClientProbe({
      url: 'http://127.0.0.1:1/',
      interactive: true,
      keepResultWindow: true,
      deps: { launch: async () => browser },
    })
    expect(outcome.signal.kind).toBe('ready')
    expect(browser.closed).toBe(false)
  } finally {
    await closeProbeResultWindows()
  }
  expect(browser.closed).toBe(true)
})
