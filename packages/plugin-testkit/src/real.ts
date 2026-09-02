/**
 * Opt-in adapters for a real installed DSH host.
 *
 * This module intentionally uses dynamic package names. Importing the normal
 * testkit entry never resolves DSH, while consumers that choose this entry get
 * a clear error if their test dependency graph lacks the host packages.
 */

import { createRequire } from 'node:module'
import type { ContextContractDriver } from './contract/context.js'
import type { WebServerContractDriver } from './contract/web-server.js'

const require = createRequire(import.meta.url)

async function loadPackage(name: string): Promise<Record<string, unknown>> {
  try {
    return (await import(name)) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `@seaveyon/dsh-plugin-testkit/real needs ${name} installed beside the test. ` +
        'Install a coherent DSH package tuple before running real-host contracts.',
      { cause: error },
    )
  }
}

/** Exact installed package versions, for a compatibility report. */
export function getInstalledRealHostVersions(): Record<string, string | undefined> {
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-tools']
  return Object.fromEntries(
    names.map((name) => {
      try {
        const manifest = require(`${name}/package.json`) as { version?: unknown }
        return [name, typeof manifest.version === 'string' ? manifest.version : undefined]
      } catch {
        return [name, undefined]
      }
    }),
  )
}

/** Create a real, root Cordis context for context-level contract scenarios. */
export async function createRealContextDriver(): Promise<ContextContractDriver> {
  const cordis = await loadPackage('@deepseek-ai/cordis')
  const Context = cordis.Context as
    | undefined
    | (new () => {
        fiber: { dispose: () => Promise<void> }
      })
  if (Context === undefined) throw new Error('@deepseek-ai/cordis does not export Context')
  const root = new Context()
  return {
    ctx: root as unknown as ContextContractDriver['ctx'],
    dispose: () => root.fiber.dispose(),
  }
}

/**
 * Activate the official webServer and expose only the registry seam the
 * contract claims. The actual HTTP server, route matcher and teardown remain
 * entirely upstream-owned.
 */
export async function createRealWebServerDriver(): Promise<WebServerContractDriver> {
  const [cordis, webserver] = await Promise.all([
    loadPackage('@deepseek-ai/cordis'),
    loadPackage('@deepseek-ai/dsh-host-webserver'),
  ])
  const Context = cordis.Context as
    | undefined
    | (new () => {
        fiber: { dispose: () => Promise<void> }
        plugin: (plugin: unknown, config: unknown) => Promise<void>
        webServer: { port: number }
      })
  const WebServer = (webserver.default ?? webserver.WebServer) as unknown
  if (Context === undefined || WebServer === undefined) {
    throw new Error('installed DSH host does not expose Context and WebServer')
  }
  const root = new Context()
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return {
    service: root.webServer as unknown as WebServerContractDriver['service'],
    listen: async () => root.webServer.port,
    dispose: () => root.fiber.dispose(),
  }
}
