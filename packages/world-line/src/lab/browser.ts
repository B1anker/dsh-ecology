/**
 * Browser boot probe (WORLD-LINE-SPEC §6 steps 4-6, Phase 3). Opens the lab's
 * experiment URL in a fresh, cache-less Playwright context and watches for the
 * empirically-derived `clientReady` signal (host-adapters/dsh-client-0.1.x):
 * shell markers + conversation/workspace shell state + mount children + boot
 * globals, with zero page/console/request errors.
 *
 * Outcome classes (§6): ready, fail (page/console/request errors, or markers
 * plus errors), inconclusive (no reliable signal: markers missing without
 * errors, crash, or no browser executable). A missing browser never fabricates
 * readiness — callers gate promotion on the recorded client state.
 *
 * The browser layer is injected through `deps` in unit tests; the real
 * launcher prefers an explicit executable, then Playwright's bundled
 * chromium, then the system "chrome" channel — never downloads browsers.
 */

import {
  CLIENT_BAD_REQUEST_RE,
  CLIENT_BOOT_GLOBALS,
  CLIENT_SHELL_MARKERS,
  CLIENT_SHELL_STATES,
} from '../host-adapters/dsh-client-0.1.x.js'

export interface BrowserHandleLike {
  close(): Promise<void>
  newContext(): Promise<BrowserContextLike>
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>
}

/** The page surface the probe uses (a Playwright Page in production). */
export interface PageLike {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  on(event: 'console' | 'pageerror' | 'requestfailed', handler: (arg: unknown) => void): void
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>
}

export interface BrowserProbeDeps {
  /** Injected browser for unit tests. */
  browser?: BrowserHandleLike
  /** Launch the real browser; returns null when none is available. */
  launch?: () => Promise<BrowserHandleLike | null>
}

export interface ShellState {
  mountChildren: number
  buttons: string[]
  roles: string[]
  bodyHas: string[]
  bootGlobals: string[]
  bootEntries: number
}

export type ClientSignal =
  | { kind: 'ready'; state: ShellState; settledMs: number }
  | { kind: 'fail'; errors: string[]; state: ShellState }
  | { kind: 'no-browser'; reason: string }
  | { kind: 'inconclusive'; reason: string; state: ShellState }

export interface ClientProbeOutcome {
  signal: ClientSignal
  /** Sorted, redacted event samples (console errors, pageerrors, requests). */
  events: string[]
}

export interface RunClientProbeInput {
  url: string
  readyTimeoutMs?: number
  deps?: BrowserProbeDeps
}

/** Try real browser launch: injected → env executable → playwright → chrome. */
async function launchRealBrowser(): Promise<BrowserHandleLike | null> {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  try {
    if (explicit !== undefined && explicit !== '') {
      const { chromium } = (await import('playwright-core')) as typeof import('playwright-core')
      return chromium.launch({ executablePath: explicit, headless: true })
    }
    const { chromium } = (await import('playwright-core')) as typeof import('playwright-core')
    try {
      return await chromium.launch({ headless: true })
    } catch {
      // Fall back to the system Google Chrome channel (macOS/Windows dev
      // machines); CI without any browser reports no-browser instead.
      return await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null)
    }
  } catch {
    return null
  }
}

/** One evaluation of the shell state (safe subset; no secrets leave the page). */
async function evaluateShell(page: PageLike): Promise<ShellState> {
  const state = await page.evaluate(() => {
    const text = (el: Element): string => (el.textContent ?? '').trim()
    const buttons = Array.from(document.querySelectorAll('button'))
      .map(text)
      .filter((value) => value !== '')
      .slice(0, 40)
    const roles = Array.from(document.querySelectorAll('[role]'))
      .map((el) => String(el.getAttribute('role') ?? ''))
      .filter(Boolean)
      .slice(0, 40)
    const mount = document.querySelector('#root')
    return {
      mountChildren: mount === null ? 0 : mount.childElementCount,
      buttons,
      roles,
      bodyHas: (document.body?.innerText ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(0, 60),
      bootGlobals: Object.keys(window).filter((key) =>
        ['__DSH_BOOT__', '__DSH_BOOT_READY__'].includes(key),
      ),
      bootEntries: (() => {
        const boot = (window as { __DSH_BOOT__?: { entries?: unknown[] } }).__DSH_BOOT__
        return Array.isArray(boot?.entries) ? boot.entries.length : 0
      })(),
    }
  })
  return {
    mountChildren: Number(state.mountChildren),
    buttons: state.buttons.map(String),
    roles: state.roles.map(String),
    bodyHas: state.bodyHas.map(String),
    bootGlobals: state.bootGlobals.map(String),
    bootEntries: Number(state.bootEntries),
  }
}

function markersReached(state: ShellState): boolean {
  const body = `${state.bodyHas.join('\n')} ${state.buttons.join(' ')}`
  return (
    state.mountChildren > 0 &&
    CLIENT_SHELL_MARKERS.every((marker) => body.includes(marker)) &&
    CLIENT_SHELL_STATES.some((stateText) => body.includes(stateText)) &&
    CLIENT_BOOT_GLOBALS.every((name) => state.bootGlobals.includes(name))
  )
}

/**
 * Open the experiment URL, poll for the shell, and classify the signal.
 * Never throws for browser-side failures — they map to fail/inconclusive.
 */
export async function runClientProbe(input: RunClientProbeInput): Promise<ClientProbeOutcome> {
  const { url } = input
  const timeoutMs = input.readyTimeoutMs ?? 60_000
  const events: string[] = []
  const errors: string[] = []
  const deps = input.deps ?? {}

  let browser: BrowserHandleLike | null = null
  try {
    if (deps.browser !== undefined) browser = deps.browser
    else if (deps.launch !== undefined) browser = await deps.launch()
    else browser = await launchRealBrowser()
    if (browser === null) {
      return {
        signal: {
          kind: 'no-browser',
          reason: 'no chromium executable available (playwright-core, chrome channel)',
        },
        events: [],
      }
    }

    const context = await browser.newContext()
    const page = await context.newPage()
    let closed = false
    page.on('console', (raw: unknown) => {
      const msg = raw as { type(): string; text(): string }
      const text = msg.text()
      events.push(`console.${msg.type()}: ${text.slice(0, 200)}`)
      if (msg.type() === 'error') errors.push(text.slice(0, 300))
    })
    page.on('pageerror', (raw: unknown) => {
      const text = String(raw).slice(0, 300)
      events.push(`pageerror: ${text}`)
      errors.push(text)
    })
    page.on('requestfailed', (raw: unknown) => {
      const request = raw as { url(): string; failure(): { errorText: string } | null }
      const failedUrl = request.url()
      if (CLIENT_BAD_REQUEST_RE.test(new URL(failedUrl).pathname)) {
        const text = `requestfailed: ${failedUrl.slice(0, 160)} ${request.failure()?.errorText ?? ''}`
        events.push(text)
        errors.push(text)
      }
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const startedAt = Date.now()
    let lastState: ShellState | null = null
    let readyMs = -1
    while (Date.now() - startedAt < timeoutMs) {
      lastState = await evaluateShell(page)
      if (markersReached(lastState)) {
        readyMs = Date.now() - startedAt
        break
      }
      await page.waitForTimeout(750)
    }
    // A settle window catches late console/page errors after markers appear.
    if (readyMs >= 0) await page.waitForTimeout(2_000)
    const finalState = lastState ?? (await evaluateShell(page))
    const finalErrors = [...errors]
    void closed
    if (finalErrors.length > 0) {
      return {
        signal: { kind: 'fail', errors: finalErrors, state: finalState },
        events,
      }
    }
    if (readyMs >= 0) {
      return {
        signal: { kind: 'ready', state: finalState, settledMs: readyMs },
        events,
      }
    }
    return {
      signal: {
        kind: 'inconclusive',
        reason: `no reliable client-ready signal within ${timeoutMs} ms (shell markers not reached, no page errors)`,
        state: finalState,
      },
      events,
    }
  } catch (error) {
    return {
      signal: {
        kind: 'inconclusive',
        reason: `browser probe crashed: ${error instanceof Error ? error.message : String(error)}`,
        state: {
          mountChildren: 0,
          buttons: [],
          roles: [],
          bodyHas: [],
          bootGlobals: [],
          bootEntries: 0,
        },
      },
      events,
    }
  } finally {
    // Never leak browsers across runs: a straggler Chromium wedges the next
    // probe (observed with --restart double boots). Injected fakes are the
    // caller's to close.
    if (browser !== null && browser !== deps.browser && browser !== undefined) {
      await browser.close().catch(() => {})
    }
  }
}

/** Convenience used by callers that resolve a browser once per host. */
export async function closeBrowser(browser: BrowserHandleLike): Promise<void> {
  await browser.close().catch(() => {})
}
