import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * Node-environment throughout: this package manages DSH profiles on disk and
 * in child processes — there is no DOM anywhere in Phase 0/1 (vault, receipt,
 * redaction, locks, doctor, timeline). Integration with a real `dsh` binary is
 * opt-in via `test:real`; the unit suite must not require DSH to be installed,
 * so every test builds its own fixture DSH home in a temp directory.
 */
export default defineConfig({
  include: ['test/**/*.test.ts'],
  isolate: true,
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
