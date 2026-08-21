import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * The suite is Node-side throughout: it opens real sockets, writes real files
 * into temporary directories, and derives real scrypt keys. `node` is rstest's
 * default environment, but it is stated explicitly because a DOM environment
 * here would not fail loudly — it would quietly shadow globals this code takes
 * from Node.
 */
export default defineConfig({
  testEnvironment: 'node',
  include: ['test/**/*.test.ts'],
  // Each file gets a fresh module registry. The integration suite mutates
  // `process.env` and decorates a shared registry object, so leaking state
  // between files would make failures depend on execution order.
  isolate: true,
})
