import { defineConfig } from '@rslib/core'

/**
 * Build configuration.
 *
 * Bundleless, like the rest of this workspace: each source module becomes its
 * own output file, so a consumer's stack trace names `instantiation.js` rather
 * than an offset into a bundle. The package has no dependencies and imports
 * nothing from Node, so the output is the source minus types.
 *
 * `@inject(...)` is a standard (TC39 2022-03) class decorator. Rsbuild's SWC
 * transform handles that version by default, and the emitted code is a plain
 * call — consumers never need a decorator transform of their own to *use* the
 * package, only to write `@inject` in their own classes (and `inject(...)(Class)`
 * works everywhere without one).
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
