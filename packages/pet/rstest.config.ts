import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * The suite is jsdom-side throughout: the code under test is the browser
 * bundle, and its tests drive the mood source and the settings panel against
 * the client doubles from `@seaveyon/dsh-plugin-testkit`. Pure logic (mood
 * derivation, settings serialization, the discovery store) runs in the same
 * environment rather than splitting the suite over two configs.
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
      // Ratcheted baseline, set just under the current measurement
      // (91.4 / 85.6 / 95.2 / 92.6). The v1.3 desktop pivot deleted the
      // page-side overlay — the suite's least-covered surface — and raised
      // every ratio; what remains is the mood core, the bridge, and the
      // settings panel, all of which the suite exercises closely. Raise these
      // numbers in steps as the suites grow — a threshold below the current
      // number fails the build when a change removes coverage, which is the
      // only thing it can usefully be.
      statements: 88,
      functions: 82,
      branches: 90,
      lines: 89,
    },
  },
})
