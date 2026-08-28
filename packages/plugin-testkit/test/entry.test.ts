/**
 * What the package entry actually hands a consumer.
 *
 * The suites next to this one import from `../src/*.js` directly, which is
 * convenient and proves nothing about the barrel. A rename that updates every
 * definition and every internal import but not `index.ts` leaves them all green
 * and the published package broken, so the entry is exercised here on its own.
 */

import { expect, test } from '@rstest/core'
import * as testkit from '../src/index.js'

test('the entry exports the doubles and nothing that needs a test runner', async () => {
  expect(Object.keys(testkit).toSorted()).toEqual([
    'assertMutualAssignability',
    'createMockContext',
    'createMockToolsPipeline',
    'createMockWebServer',
    'fakeRequest',
    'fakeResponse',
    'fakeStreamingRequest',
    'runWaterfall',
  ])
  for (const [name, value] of Object.entries(testkit)) {
    expect(typeof value, name).toBe('function')
  }

  // The conformance suite declares tests, so it needs `@rstest/core`, which is
  // an optional peer. Re-exporting it here would make every consumer of the
  // doubles install a runner they may not use.
  expect(Object.keys(testkit)).not.toContain('runWebServerContract')
  expect(Object.keys(testkit)).not.toContain('runContextContract')
  expect(Object.keys(testkit)).not.toContain('runToolsPipelineContract')
  const contract = await import('../src/contract.js')
  expect(typeof contract.runWebServerContract).toBe('function')
  expect(typeof contract.runContextContract).toBe('function')
  expect(typeof contract.runToolsPipelineContract).toBe('function')
})

test('the doubles from the entry are the ones the suites exercise', async () => {
  const [context, http, tools, webServer] = await Promise.all([
    import('../src/context.js'),
    import('../src/http.js'),
    import('../src/tools.js'),
    import('../src/web-server.js'),
  ])
  expect(testkit.createMockContext).toBe(context.createMockContext)
  expect(testkit.createMockToolsPipeline).toBe(tools.createMockToolsPipeline)
  expect(testkit.createMockWebServer).toBe(webServer.createMockWebServer)
  expect(testkit.fakeRequest).toBe(http.fakeRequest)
  expect(testkit.fakeResponse).toBe(http.fakeResponse)
  expect(testkit.fakeStreamingRequest).toBe(http.fakeStreamingRequest)
})
