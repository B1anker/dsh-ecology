/**
 * Hold this package's host contract and the testkit's to each other.
 *
 * `src/types.ts` declares the dsh `webServer` service and the Cordis context by
 * hand, and so does `@seaveyon/dsh-plugin-testkit`. Both have to: neither can
 * import from a host package that is an optional peer at a version the public
 * registry does not carry. But two hand-written copies of one contract is
 * exactly the setup where a change lands in one and not the other, and the
 * symptom would be a mock that satisfies the tests while describing a host the
 * plugin can no longer talk to.
 *
 * Structural typing makes the agreement checkable. These assignments compile
 * only while the two descriptions remain mutually substitutable — an added
 * required member, a narrowed parameter, or a changed return type on either
 * side is a compile error here, in the one file whose job is to notice.
 *
 * The runtime assertion is incidental. `typecheck` is what actually enforces
 * this; the test exists so the file is also part of the suite rather than
 * something only the compiler ever reads.
 *
 * @module test/contract/host-types
 */

import { expect, test } from '@rstest/core'
import type {
  PluginContext as KitContext,
  Route as KitRoute,
  UpgradeRoute as KitUpgradeRoute,
  WebServerService as KitWebServer,
} from '@seaveyon/dsh-plugin-testkit'
import type { PluginContext, Route, UpgradeRoute, WebServerService } from '../../src/types.js'

/** Anything the testkit produces must be usable where this package expects it. */
type KitSatisfiesPlugin = {
  webServer: (value: KitWebServer) => WebServerService
  context: (value: KitContext) => PluginContext
  route: (value: KitRoute) => Route
  upgrade: (value: KitUpgradeRoute) => UpgradeRoute
}

/** And the reverse, so neither side can quietly become the broader one. */
type PluginSatisfiesKit = {
  webServer: (value: WebServerService) => KitWebServer
  context: (value: PluginContext) => KitContext
  route: (value: Route) => KitRoute
  upgrade: (value: UpgradeRoute) => KitUpgradeRoute
}

const identity = <T>(value: T): T => value

const kitSatisfiesPlugin: KitSatisfiesPlugin = {
  webServer: identity,
  context: identity,
  route: identity,
  upgrade: identity,
}

const pluginSatisfiesKit: PluginSatisfiesKit = {
  webServer: identity,
  context: identity,
  route: identity,
  upgrade: identity,
}

test('the plugin and the testkit describe the same host', () => {
  expect(Object.keys(kitSatisfiesPlugin)).toEqual(Object.keys(pluginSatisfiesKit))
})
