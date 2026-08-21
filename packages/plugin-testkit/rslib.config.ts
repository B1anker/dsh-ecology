import { defineConfig } from '@rslib/core'

/**
 * Build configuration.
 *
 * Bundleless, like the rest of this workspace: each source module becomes its
 * own output file. Here that is not only a readability choice but a correctness
 * one, because `exports` publishes `./contract` as a separate entry point. A
 * bundle would fold `@rstest/core` into the same file as the mocks, and the
 * whole reason for the split is that the mocks must be usable without a test
 * runner installed.
 */
export default defineConfig({
  lib: [
    {
      format: 'esm',
      bundle: false,
      dts: true,
      syntax: 'es2022',
      source: {
        entry: { index: ['./src/**/*.ts'] },
        // Declarations follow this tsconfig, not the default one, so they land
        // beside the files they describe rather than under `dist/src/`.
        tsconfigPath: './tsconfig.build.json',
      },
    },
  ],
  output: {
    target: 'node',
    distPath: { root: './dist' },
    // Rewriting the whole directory on each build guarantees that a module
    // deleted from src cannot survive in dist and keep resolving.
    cleanDistPath: true,
  },
})
