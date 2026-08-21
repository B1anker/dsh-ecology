/**
 * The mock registry, run through the contract it exists to satisfy.
 *
 * This is the package holding itself to its own promise. `createMockWebServer`
 * is only worth anything if a plugin tested against it behaves the same against
 * a dsh host, and the contract suite is where that claim is written down.
 *
 * @module test/conformance
 */

import { runWebServerContract } from '../src/contract.js'
import { createMockWebServer } from '../src/web-server.js'

runWebServerContract('mock webServer', () => createMockWebServer())
