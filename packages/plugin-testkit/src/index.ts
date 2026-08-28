/**
 * dsh-plugin-testkit — test doubles and a conformance suite for dsh plugins.
 *
 * A dsh plugin binds to host surfaces it cannot install: the `webServer` route
 * registry, the Cordis plugin context (including events), and — for hook
 * plugins — the tools execution waterfalls. Testing against a real dsh process
 * is heavy; testing against nothing tests nothing. This package is the third
 * option — doubles with the same shape, small enough to read in one sitting,
 * plus the part that keeps them honest.
 *
 * The conformance runners live behind the `/contract` subpath rather than here,
 * because they declare tests and therefore need a runner; everything in this
 * entry works without one.
 *
 * ```ts
 * import {
 *   createMockContext,
 *   createMockToolsPipeline,
 *   createMockWebServer,
 * } from '@seaveyon/dsh-plugin-testkit'
 *
 * const web = createMockWebServer()
 * const ctx = createMockContext({ webServer: web.service })
 * const tools = createMockToolsPipeline(ctx)
 * apply(ctx, { ...config })
 * ```
 *
 * Nothing here is for production use.
 *
 * @module @seaveyon/dsh-plugin-testkit
 */

export type { CapturedLogs, CapturedTeardown, MockContext } from './context.js'
export { createMockContext } from './context.js'
export type { ListenerMap } from './events.js'
export { runWaterfall } from './events.js'
export type {
  FakeRequestOptions,
  FakeResponse,
  RecordedResponse,
  StreamingRequest,
} from './http.js'
export { fakeRequest, fakeResponse, fakeStreamingRequest } from './http.js'
export type {
  AskAnswerer,
  MockToolsPipeline,
  MockToolsPipelineOptions,
  ToolCallInput,
} from './tools.js'
export { createMockToolsPipeline } from './tools.js'
export type {
  ContextListener,
  Disposer,
  Logger,
  PluginContext,
  PreToolDecision,
  Route,
  RouteHandler,
  RouteKind,
  ToolBody,
  ToolExecution,
  ToolResult,
  ToolsService,
  UpgradeHandler,
  UpgradeRoute,
  WebServerService,
} from './types.js'
export { assertMutualAssignability } from './types.js'
export type { MockWebServer } from './web-server.js'
export { createMockWebServer } from './web-server.js'
