import { defineConfig } from '@rstest/core'

/**
 * Test configuration.
 *
 * The suite is Node-side: it initializes real Git repositories in temporary
 * directories and drives the management API over a real socket through the
 * testkit's registry and connection doubles.
 */
export default defineConfig({
  testEnvironment: 'node',
  include: ['test/**/*.test.ts'],
  // The worktree tests run a dozen real `git` invocations each — about a
  // second on a quiet machine, several times that when the repository runs
  // every package's suite at once. Budget for the shared CPU, not for speed.
  testTimeout: 20_000,
  coverage: {
    // Off by default and on in CI, where the ratchet below is what matters.
    enabled: false,
    provider: 'v8',
    include: ['src/*.ts'],
    exclude: [
      // The browser bundle's source, emitted alongside the Node modules by the
      // ESM build. It runs in the shell against react and the ui primitives;
      // v8 instrumentation of a Node test run cannot reach it, so counting it
      // would report a permanent hole the suite is not meant to fill.
      'src/client.ts',
      'src/client-contracts.ts',
      'src/locales.ts',
      'src/strings.ts',
      'src/sidebar-worktree-grouper.ts',
      'src/worktree-api.ts',
      'src/worktree-control.ts',
      'src/worktree-removal-modal.ts',
      // `open -R` / `explorer /select` glue: exercising it opens a window on
      // the developer's desktop. The route that calls it is covered.
      'src/reveal.ts',
    ],
    reporters: ['text'],
    thresholds: {
      // Set just under where the suite sits, as a ratchet: a change that
      // removes coverage fails the build; one that forgets to add it does not.
      statements: 60,
      functions: 60,
      branches: 50,
      lines: 62,
      // The fence and the body/response helpers every route goes through.
      'src/web.ts': {
        statements: 60,
        branches: 50,
        perFile: true,
      },
    },
  },
})
