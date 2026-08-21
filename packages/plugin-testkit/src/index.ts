/**
 * dsh-plugin-testkit — test doubles and a conformance suite for dsh plugins.
 *
 * A dsh plugin binds to two host surfaces it cannot install: the `webServer`
 * route registry and the Cordis plugin context. Testing against either for real
 * means running a dsh process; testing against neither means testing nothing.
 * This package is the third option — doubles with the same shape, small enough
 * to read in one sitting, plus the part that keeps them honest.
 *
 * That last part is the reason this is a package rather than a folder of
 * helpers. A mock drifting from the host it imitates is the worst failure mode
 * available to a test suite: everything stays green while the thing being
 * described stops existing. {@link runWebServerContract} states the registry's
 * behaviour once, so the same assertions can be pointed at the mock here and at
 * a real host adapter when one can be installed. It lives behind the
 * `/contract` subpath rather than here, because it declares tests and therefore
 * needs a runner; everything in this entry works without one.
 *
 * ```ts
 * import { createMockContext, createMockWebServer } from '@seaveyon/dsh-plugin-testkit'
 *
 * const web = createMockWebServer()
 * const ctx = createMockContext({ webServer: web.service })
 * apply(ctx, { ...config })
 * const port = await web.listen()
 * ```
 *
 * Nothing here is for production use. It is published because the packages that
 * need it are published separately and each has to be able to depend on a
 * version of it.
 *
 * @module @seaveyon/dsh-plugin-testkit
 */

export type { CapturedLogs, CapturedTeardown, MockContext } from './context.js'
export { createMockContext } from './context.js'
export type {
  FakeRequestOptions,
  FakeResponse,
  RecordedResponse,
  StreamingRequest,
} from './http.js'
export { fakeRequest, fakeResponse, fakeStreamingRequest } from './http.js'
export type {
  Disposer,
  Logger,
  PluginContext,
  Route,
  RouteHandler,
  RouteKind,
  UpgradeHandler,
  UpgradeRoute,
  WebServerService,
} from './types.js'
export type { MockWebServer } from './web-server.js'
export { createMockWebServer } from './web-server.js'
