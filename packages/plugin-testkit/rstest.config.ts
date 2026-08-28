import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * Node-side throughout: the suite opens real sockets, because a mock HTTP
 * registry that was only ever exercised in memory would not be evidence of
 * anything a plugin can rely on.
 */
export default defineConfig({
  testEnvironment: 'node',
  include: ['test/**/*.test.ts'],
  isolate: true,
  coverage: {
    // Off by default and on in CI. See the same setting in web-login.
    enabled: false,
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: [
      // Declarations only; it emits no JavaScript and would sit at 0% forever.
      // `assertMutualAssignability` lives here too — a type-level no-op covered
      // by the entry export check rather than a runtime branch.
      'src/types.ts',
      // Re-export barrels. Checked by `test/entry.test.ts` instead.
      'src/index.ts',
      'src/contract.ts',
      // Conformance suites declare tests; they are runners, not doubles. Covering
      // every arrow inside an assertion that intentionally skips a tool body is
      // not the signal these thresholds exist for.
      'src/contract-web-server.ts',
      'src/contract-context.ts',
      'src/contract-tools.ts',
    ],
    reporters: ['text', 'html'],
    thresholds: {
      // Held higher than the plugin's own floor, for a reason particular to
      // this package: an uncovered branch in a test double is a behaviour that
      // no downstream suite has ever observed, and every one of them will trust
      // it as if they had.
      statements: 95,
      functions: 95,
      branches: 90,
      lines: 95,
    },
  },
})
