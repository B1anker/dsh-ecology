/**
 * A Cordis-like plugin context.
 *
 * Enough of the real thing for a plugin's `apply` to run: services to `get`,
 * `effect` to collect teardowns, a logger that records rather than prints, and
 * `set`/`provide` for anything the plugin publishes. What it adds beyond the
 * real context is inspection — the teardowns and the log lines are readable
 * afterwards, because "what did this plugin log on failure?" is a security
 * question in any package that handles credentials.
 *
 * @module @seaveyon/dsh-plugin-testkit/context
 */

import type { Disposer, Logger, PluginContext } from './types.js'

/** What the plugin logged, split by level. */
export interface CapturedLogs {
  info: string[]
  warn: string[]
}

/** A registered teardown and the label the plugin gave it. */
export interface CapturedTeardown {
  teardown: Disposer
  label: string | undefined
}

/** The mock context, plus the state a test inspects afterwards. */
export interface MockContext extends PluginContext {
  teardowns: CapturedTeardown[]
  logs: CapturedLogs
  /** Run every teardown in reverse order, as Cordis does on disposal. */
  dispose: () => void
}

/**
 * Create a context sufficient for a plugin's use of one.
 * @param services - services the plugin will `get`; also where `set` writes.
 * @returns the context, plus the collected teardown callbacks and log lines.
 */
export function createMockContext(services: Record<string, unknown>): MockContext {
  const teardowns: CapturedTeardown[] = []
  const logs: CapturedLogs = { info: [], warn: [] }
  const logger: Logger = {
    info: (line) => logs.info.push(line),
    warn: (line) => logs.warn.push(line),
  }
  return {
    get: <T>(name: string) => services[name] as T | undefined,
    effect(setup, label) {
      const teardown = setup()
      if (typeof teardown === 'function') teardowns.push({ teardown, label })
    },
    set(name, value) {
      services[name] = value
    },
    logger,
    teardowns,
    logs,
    dispose() {
      for (const { teardown } of [...teardowns].toReversed()) teardown()
    },
  }
}
