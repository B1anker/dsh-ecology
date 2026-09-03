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
      // Honest baseline for v0.1.x, set just under the current measurement
      // (75.9 / 69.7 / 73.1 / 78.1). The overlay and settings-panel UI plus the
      // SVG-heavy pet sprites are only partially exercised by the suite, so a
      // 90% floor at this stage would be a wish, not a ratchet. Raise these
      // numbers in steps as the UI suites grow during v1 — a threshold below
      // the current number fails the build when a change removes coverage,
      // which is the only thing it can usefully be.
      statements: 74,
      functions: 68,
      branches: 70,
      lines: 75,
    },
  },
})
