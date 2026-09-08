import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactText } from '../domain/redaction.js'
import { artifactCleanup } from './artifacts.js'
/** Browser collector for the supported host. Stable shell/loader assertions
 * are independent from console and network observations. Confirmed host asset
 * failures block; unknown impact remains inconclusive across all callers.
 * Automatic probes close owned resources; visible Web probes leave a bounded
 * result window after the runner stops the lab process.
 */

import {
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
  close?(): Promise<void>
  tracing?: {
    start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>
    stop(options?: { path?: string }): Promise<void>
  }
}

/** The page surface the probe uses (a Playwright Page in production). */
export interface PageLike {
  close?(): Promise<void>
  screenshot?(options: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  on(
    event: 'console' | 'pageerror' | 'requestfailed' | 'response',
    handler: (arg: unknown) => void,
  ): void
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>
}

export interface BrowserProbeDeps {
  /** Injected browser for unit tests. */
  browser?: BrowserHandleLike
  /** Launch the real browser; returns null when none is available. */
  launch?: () => Promise<BrowserHandleLike | null>
}

export interface ShellState {
  loaderFailed?: boolean
  loginRequired?: boolean
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

export interface BrowserObservation {
  id: string
  kind: 'console' | 'exception' | 'network' | 'http'
  source: 'host' | 'external' | 'unknown'
  address?: string
  resourceType?: string
  message: string
  impact: 'blocking' | 'review' | 'warning'
}
export interface ClientProbeOutcome {
  observations?: BrowserObservation[]

  signal: ClientSignal
  /** Sorted, redacted event samples (console errors, pageerrors, requests). */
  events: string[]
  artifacts?: { directory: string; files: string[]; private: true; notes: string[] }
}

export interface RunClientProbeInput {
  url: string
  /** Private local storage; artifact bytes are never embedded in redacted reports. */
  artifactRoot?: string
  artifactContext?: 'lab-verification' | 'promotion-restart'
  interactive?: boolean
  /** Web owner keeps a result window for five minutes; no lab process lease. */
  keepResultWindow?: boolean
  readyTimeoutMs?: number
  delegatedSession?: boolean
  onPhase?: (phase: string) => void

  deps?: BrowserProbeDeps
}

const resultWindows = new Set<BrowserHandleLike>()

export async function closeProbeResultWindows(): Promise<void> {
  const windows = [...resultWindows]
  resultWindows.clear()
  await Promise.allSettled(windows.map((browser) => browser.close()))
}

/** Try real browser launch: injected → env executable → playwright → chrome. */
async function launchRealBrowser(headless = true): Promise<BrowserHandleLike | null> {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  try {
    if (explicit !== undefined && explicit !== '') {
      const { chromium } = (await import('playwright-core')) as typeof import('playwright-core')
      return chromium.launch({ executablePath: explicit, headless })
    }
    const { chromium } = (await import('playwright-core')) as typeof import('playwright-core')
    try {
      return await chromium.launch({ headless })
    } catch {
      // Fall back to the system Google Chrome channel (macOS/Windows dev
      // machines); CI without any browser reports no-browser instead.
      return await chromium.launch({ channel: 'chrome', headless }).catch(() => null)
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
      loaderFailed:
        !!document.querySelector('[data-dsh-boot]') &&
        (document.querySelector('[data-dsh-boot]')?.textContent ?? '').includes(
          'Failed to load plugins',
        ),
      loginRequired: location.pathname === '/login' || location.pathname.startsWith('/auth/'),
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
    loaderFailed: state.loaderFailed === true,
    loginRequired: state.loginRequired === true,
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
  const observations: BrowserObservation[] = []
  const hostOrigin = new URL(url).origin
  const observe = (
    kind: BrowserObservation['kind'],
    message: string,
    address?: string,
    resourceType?: string,
    cancelled = false,
  ) => {
    let safeAddress: string | undefined
    let source: BrowserObservation['source'] = 'unknown'
    try {
      const parsed = new URL(address ?? '')
      safeAddress = parsed.origin + parsed.pathname
      source = parsed.origin === hostOrigin ? 'host' : 'external'
    } catch {}
    // Only a failed host document/script/stylesheet is independently blocking.
    // API and external failures need capability evidence; a console line is not a verdict.
    const impact = cancelled
      ? 'warning'
      : source === 'host' && ['document', 'script', 'stylesheet'].includes(resourceType ?? '')
        ? 'blocking'
        : 'review'
    observations.push({
      id: `event-${observations.length + 1}`,
      kind,
      source,
      ...(safeAddress ? { address: safeAddress } : {}),
      ...(resourceType ? { resourceType } : {}),
      message: redactText(message).slice(0, 500),
      impact,
    })
  }
  const deps = input.deps ?? {}

  let browser: BrowserHandleLike | null = null
  let context: BrowserContextLike | undefined
  let page: PageLike | undefined
  let artifactDir: string | undefined
  let tracing = false
  let retainWindow = false
  let succeeded = false
  let artifacts: ClientProbeOutcome['artifacts']
  const captureNotes: string[] = []
  const execute = async (): Promise<ClientProbeOutcome> => {
    try {
      if (deps.browser !== undefined) browser = deps.browser
      else if (deps.launch !== undefined) browser = await deps.launch()
      else browser = await launchRealBrowser(input.interactive !== true)
      if (browser === null) {
        return {
          signal: {
            kind: 'no-browser',
            reason: 'no chromium executable available (playwright-core, chrome channel)',
          },
          events: [],
        }
      }

      context = await browser.newContext()
      if (input.artifactRoot) {
        try {
          await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 })
          const info = await lstat(input.artifactRoot)
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid artifact root')
          artifactDir = await mkdtemp(join(input.artifactRoot, `probe-${Date.now()}-`))
          await chmod(artifactDir, 0o700)
          if (context.tracing && !input.delegatedSession) {
            await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
            tracing = true
          } else
            captureNotes.push(
              input.delegatedSession
                ? '短时认证验证不记录网络 trace，避免保存实验凭证。'
                : '此浏览器不支持 trace。',
            )
        } catch {
          captureNotes.push('无法开始记录浏览器工件。')
        }
      }
      page = await context.newPage()
      page.on('console', (raw: unknown) => {
        const msg = raw as { type(): string; text(): string; location?(): { url?: string } }
        let location = ''
        try {
          const u = new URL(msg.location?.().url ?? '')
          location = ` (${u.origin}${u.pathname})`
        } catch {}
        const text = msg.text() + location
        events.push(`console.${msg.type()}: ${text.slice(0, 200)}`)
        if (msg.type() === 'error') observe('console', msg.text(), msg.location?.().url)
      })
      page.on('pageerror', (raw: unknown) => {
        const text = String(raw).slice(0, 300)
        events.push(`pageerror: ${text}`)
        observe('exception', text)
      })
      page.on('requestfailed', (raw: unknown) => {
        const request = raw as {
          url(): string
          resourceType?(): string
          failure(): { errorText: string } | null
        }
        const message = request.failure()?.errorText ?? 'request failed'
        observe(
          'network',
          message,
          request.url(),
          request.resourceType?.(),
          /ERR_ABORTED/.test(message),
        )
        const event = observations.at(-1)!
        events.push(`requestfailed: ${event.address ?? 'unknown'} ${event.message}`)
      })
      page.on('response', (raw: unknown) => {
        const response = raw as {
          status(): number
          url(): string
          request(): { resourceType?(): string }
        }
        if (response.status() >= 400) {
          observe(
            'http',
            `HTTP ${response.status()}`,
            response.url(),
            response.request().resourceType?.(),
          )
          const event = observations.at(-1)!
          events.push(`response: ${event.address ?? 'unknown'} ${event.message}`)
        }
      })

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const startedAt = Date.now()
      let lastState: ShellState | null = null
      let readyMs = -1
      while (Date.now() - startedAt < timeoutMs) {
        lastState = await evaluateShell(page)
        if (lastState.loginRequired)
          input.onPhase?.(
            '等待登录：请在验证窗口完成登录，之后自动继续；无需配置模型即可检查兼容性',
          )
        if (lastState.loaderFailed)
          return {
            signal: {
              kind: 'fail',
              errors: ['宿主加载器报告插件加载或激活失败'],
              state: lastState,
            },
            events,
          }
        if (lastState.loginRequired && !input.interactive) {
          return {
            signal: {
              kind: 'inconclusive',
              state: lastState,
              reason:
                '需要登录：验证浏览器停在登录页，尚未检查插件。请选择「在本机浏览器中登录并重新验证」，完成登录后自动继续。',
            },
            events,
          }
        }
        if (markersReached(lastState)) {
          readyMs = Date.now() - startedAt
          break
        }
        await page.waitForTimeout(750)
      }
      // A settle window catches late console/page errors after markers appear.
      if (readyMs >= 0) {
        input.onPhase?.('核心界面已出现，正在观察 5 秒稳定窗口；不调用模型或检查 API key')
        for (let sample = 0; sample < 5; sample++) {
          await page.waitForTimeout(1_000)
          lastState = await evaluateShell(page)
          if (!markersReached(lastState) || lastState.loaderFailed) break
        }
      }
      const finalState = lastState ?? (await evaluateShell(page))
      const finalErrors = observations
        .filter((o) => o.impact === 'blocking')
        .map((o) => `${o.address ?? ''} ${o.message}`)
      if (
        readyMs >= 0 &&
        (!markersReached(finalState) || finalState.loaderFailed) &&
        !finalState.loginRequired
      )
        finalErrors.push('核心界面在稳定观察期间消失或加载器报告失败')
      if (finalErrors.length > 0) {
        return {
          signal: { kind: 'fail', errors: finalErrors, state: finalState },
          events,
        }
      }
      if (readyMs >= 0 && markersReached(finalState) && !finalState.loginRequired) {
        succeeded = !observations.some((o) => o.impact === 'review')
        return {
          signal: { kind: 'ready', state: finalState, settledMs: readyMs },
          events,
        }
      }
      return {
        signal: {
          kind: 'inconclusive',
          reason: finalState.loginRequired
            ? '等待登录超时：请在本机验证浏览器完成登录后重试；正式环境未改动。'
            : `no reliable client-ready signal within ${timeoutMs} ms (shell markers not reached, no page errors)`,
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
      if (artifactDir) {
        const files: string[] = []
        if (!succeeded && page?.screenshot) {
          try {
            await page.screenshot({
              path: join(artifactDir, 'failure.png'),
              fullPage: false,
              timeout: 5000,
            })
            await chmod(join(artifactDir, 'failure.png'), 0o600)
            files.push('failure.png')
          } catch {
            captureNotes.push('截图未能保存。')
          }
        }
        if (tracing) {
          try {
            await context!.tracing!.stop(
              succeeded ? undefined : { path: join(artifactDir, 'trace.zip') },
            )
            if (!succeeded) {
              await chmod(join(artifactDir, 'trace.zip'), 0o600)
              files.push('trace.zip')
            }
          } catch {
            captureNotes.push('trace 未能保存。')
          }
        }
        if (succeeded) await rm(artifactDir, { recursive: true, force: true }).catch(() => {})
        else {
          artifacts = { directory: artifactDir, files, private: true, notes: captureNotes }
          await writeFile(
            join(artifactDir, 'index.json'),
            JSON.stringify({
              version: 1,
              createdAt: new Date().toISOString(),
              context: input.artifactContext ?? 'browser-probe',
              files,
              private: true,
              notes: captureNotes,
            }),
            { mode: 0o600 },
          ).catch(() => {
            captureNotes.push('工件索引未能保存。')
          })
        }
      }
      if (input.artifactRoot) {
        await artifactCleanup(input.artifactRoot)
          .then((plan) => artifactCleanup(input.artifactRoot!, true, plan.revision))
          .catch(() => {
            captureNotes.push('历史工件清理未完成，可在报告中重试。')
          })
      }
      if (
        input.interactive &&
        input.keepResultWindow &&
        browser &&
        browser !== deps.browser &&
        context
      ) {
        try {
          // End tracing first. The tool result is not part of tested DOM evidence.
          const resultPage = await context.newPage()
          const title = succeeded ? '兼容性检查已完成' : '验证已结束，请查看结果'
          const html = `<html lang="zh"><meta charset="utf-8"><title>世界线 · 验证结果</title><style>body{font:18px system-ui;background:#f5f6fa;color:#252933;display:grid;place-items:center;height:95vh}main{max-width:580px;padding:36px;background:#ffffffdc;border-top:3px solid #edbb16;box-shadow:0 20px 60px #3331}small{letter-spacing:3px;color:#657080}p{line-height:1.7}</style><main><small>WORLD LINE / RESULT</small><h1>${title}</h1><p>实验服务已结束自动检查。返回原来的世界线面板查看具体结果和下一步操作。</p><p>本次没有调用模型；跳过 API key 配置不会导致安装失败。插件业务功能的覆盖范围在结果中单独说明。</p><p>此窗口可手动关闭，或在五分钟后自动关闭。已安装的实验仍按保留策略保存。</p></main></html>`
          await resultPage.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 5000,
          })
          await page?.close?.().catch(() => {})
          retainWindow = true
          const owned = browser
          resultWindows.add(owned)
          while (resultWindows.size > 3) {
            const oldest = resultWindows.values().next().value!
            resultWindows.delete(oldest)
            await oldest.close().catch(() => {})
          }
          const timer = setTimeout(() => {
            resultWindows.delete(owned)
            void owned.close().catch(() => {})
          }, 5 * 60_000)
          timer.unref()
        } catch {
          captureNotes.push('结果窗口无法保留，请回到世界线面板查看。')
        }
      }
      if (!retainWindow) await context?.close?.().catch(() => {})
      // Never leak browsers across runs: a straggler Chromium wedges the next
      // probe (observed with --restart double boots). Injected fakes are the
      // caller's to close.
      if (!retainWindow && browser !== null && browser !== deps.browser && browser !== undefined) {
        await browser.close().catch(() => {})
      }
    }
  }
  const outcome = await execute()
  if (outcome.signal.kind === 'ready' && observations.some((o) => o.impact === 'review')) {
    outcome.signal = {
      kind: 'inconclusive',
      state: outcome.signal.state,
      reason: '核心界面检查通过，但运行异常的影响尚未确认；请查看请求来源并试用相关功能。',
    }
  }
  outcome.events = outcome.events.map(redactText)
  if (outcome.signal.kind === 'fail') outcome.signal.errors = outcome.signal.errors.map(redactText)
  if (outcome.signal.kind === 'inconclusive')
    outcome.signal.reason = redactText(outcome.signal.reason)
  return { ...outcome, observations, ...(artifacts ? { artifacts } : {}) }
}

/** Convenience used by callers that resolve a browser once per host. */
export async function closeBrowser(browser: BrowserHandleLike): Promise<void> {
  await browser.close().catch(() => {})
}
