/** Adapters that let the built-in doubles run runner-independent contracts. */

import { createMockContext } from './context.js'
import type { ContextContractDriver } from './contract/context.js'
import type { WebServerContractDriver } from './contract/web-server.js'
import { createMockWebServer } from './web-server.js'

/** Create a mock context in the same shape consumed by context contract cases. */
export function createMockContextDriver(): ContextContractDriver {
  const ctx = createMockContext({})
  return { ctx, dispose: ctx.dispose }
}

/** Create a mock route registry in the same shape consumed by web contract cases. */
export function createMockWebServerDriver(): WebServerContractDriver {
  const web = createMockWebServer()
  return { service: web.service, listen: web.listen, dispose: web.close }
}
