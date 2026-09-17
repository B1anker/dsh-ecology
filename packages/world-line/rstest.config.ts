import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * Node-environment by default: this package manages DSH profiles on disk and
 * in child processes, and the CLI/web suites have no DOM. The few client
 * tests that need one (the panel's error boundary, the world reader) opt in
 * per file with a `// @rstest-environment jsdom` docblock. Integration with a
 * real `dsh` binary is opt-in via `test:real`; the unit suite must not require
 * DSH to be installed, so every test builds its own fixture DSH home in a
 * temp directory.
 */
export default defineConfig({
  include: ['test/**/*.test.ts'],
  isolate: true,
  tools: {
    swc: {
      jsc: {
        // The client sources use the automatic JSX runtime (react is external
        // in the bundle); SWC's classic default would look for a React
        // identifier those sources never import.
        transform: { react: { runtime: 'automatic' } },
      },
    },
  },
  // Many tests spawn real child processes — the shipped CLI, a node-based dsh
  // shim booted through the lab launcher, git — and wait for them to settle.
  // The runner's 5 s default is measured against a quiet machine; the
  // repository runs every package's suite at once (`bun run --filter '*'
  // test:unit`), where node cold starts alone can eat a second or two, and
  // the slowest tests here (promote with restart verification, investigation
  // trials) then tripped the default intermittently. A hung test still fails;
  // it just does so on a budget that tolerates the shared CPU.
  testTimeout: 30_000,
  hookTimeout: 30_000,
  coverage: {
    // Off by default and on in CI, because collecting it costs about a third of
    // the run and the answer only has to be right before a merge.
    enabled: false,
    provider: 'v8',
    include: ['src/**/*.ts'],
    reporters: ['text', 'html'],
    thresholds: {
      // Ratchet baseline for the Phase 0/1 surface (measured 2026-09-04:
      // 80 / 84 / 61 / 84). index.ts and types.ts are re-export/type-only
      // files and report 0 by construction; the aggregate must stay clear of
      // them.
      statements: 74,
      functions: 72,
      branches: 54,
      lines: 76,
    },
  },
})
