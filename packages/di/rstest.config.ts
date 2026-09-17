import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * Pure Node, no I/O: the container is a data structure and its tests are
 * about resolution order, caching, error text and disposal.
 */
export default defineConfig({
  testEnvironment: 'node',
  include: ['test/**/*.test.ts'],
  coverage: {
    // Off by default and on in CI. See the same setting in web-login.
    enabled: false,
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: [
      // Re-export barrel. Checked by `test/entry.test.ts` instead.
      'src/index.ts',
    ],
    reporters: ['text', 'html'],
    thresholds: {
      // A container is trusted blindly by every service built through it, so
      // an uncovered branch here is a resolution path no consumer has ever
      // seen work. Held at the testkit's level for the same reason.
      statements: 95,
      functions: 95,
      branches: 90,
      lines: 95,
    },
  },
})
