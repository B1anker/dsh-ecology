import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * The suite is jsdom-side throughout: the code under test is the browser
 * bundle, and its tests mount the overlay against the client doubles from
 * `@seaveyon/dsh-plugin-testkit`. Pure logic (mood derivation, settings
 * serialization, position clamping) runs in the same environment rather than
 * splitting the suite over two configs.
 */
export default defineConfig({
  testEnvironment: 'jsdom',
  include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  isolate: true,
  tools: {
    swc: {
      jsc: {
        // The sources use the automatic JSX runtime (react is external in the
        // bundle); SWC defaults to the classic runtime, which expects a React
        // identifier in scope that react-jsx sources never import.
        transform: { react: { runtime: 'automatic' } },
      },
    },
  },
  coverage: {
    // Off by default and on in CI, because collecting it costs about a third of
    // the run and the answer only has to be right before a merge.
    enabled: false,
    provider: 'v8',
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    reporters: ['text', 'html'],
    thresholds: {
      // Set just under where the suite already sits. A threshold above the
      // current number is a wish; one below it is a ratchet, which is the only
      // thing it can usefully be — it fails the build when a change removes
      // coverage rather than when someone forgets to add it.
      statements: 90,
      functions: 90,
      branches: 85,
      lines: 90,
    },
  },
})
