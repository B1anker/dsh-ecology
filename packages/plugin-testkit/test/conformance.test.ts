/**
 * The doubles, run through the contracts they exist to satisfy.
 *
 * @module test/conformance
 */

import { createMockContext } from '../src/context.js'
import {
  runContextContract,
  runToolsPipelineContract,
  runWebServerContract,
} from '../src/contract.js'
import { createMockToolsPipeline } from '../src/tools.js'
import { createMockWebServer } from '../src/web-server.js'

runWebServerContract('mock webServer', () => createMockWebServer())

runContextContract('mock context', () => createMockContext({}))

runToolsPipelineContract('mock tools', () => {
  const ctx = createMockContext({})
  return { ctx, pipeline: createMockToolsPipeline(ctx) }
})
