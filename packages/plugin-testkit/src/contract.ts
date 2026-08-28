/**
 * Conformance suites for the doubles in this package.
 *
 * Importing this pulls in `@rstest/core`, which is an optional peer: the modules
 * declare tests, so they are only usable from inside a runner. The doubles
 * themselves live on the main entry and need no runner.
 *
 * @module @seaveyon/dsh-plugin-testkit/contract
 */

export { runContextContract } from './contract-context.js'
export type { ToolsPipelineHarness } from './contract-tools.js'
export { runToolsPipelineContract } from './contract-tools.js'
export type { WebServerHarness } from './contract-web-server.js'
export { runWebServerContract } from './contract-web-server.js'
