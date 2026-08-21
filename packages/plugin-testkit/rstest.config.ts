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
      'src/types.ts',
      // A re-export barrel. The bundler resolves its bindings at build time, so
      // nothing of it survives into a module the provider can attribute
      // execution to, and it reports a permanent 0%. It is checked instead by
      // `test/entry.test.ts`, which asserts the export list directly.
      'src/index.ts',
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
