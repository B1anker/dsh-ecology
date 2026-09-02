import { defineConfig } from '@rslib/core'

/**
 * Build configuration.
 *
 * Two entries rather than one, for two reasons that pull in the same direction.
 *
 * Bundleless mode (`bundle: false`) transforms each source file into its own
 * output file instead of concatenating them. That matters here because the
 * modules are separately meaningful — a reader chasing a security question about
 * cookie handling should find `dist/cookies.js`, not a line range inside one
 * bundle — and because `dist/hash-password.js` needs to import the same
 * `verifier.js` the plugin uses rather than carry a second copy of the KDF.
 *
 * The CLIs are their own entry only so the shebang can be attached to them
 * alone. `banner.js` applies to every file an entry emits, so a single combined
 * entry would prepend `#!/usr/bin/env node` to all library modules.
 */
export default defineConfig({
  lib: [
    {
      // The library surface: every module except the CLIs, which the second
      // entry claims. Type declarations are generated here, so the published
      // `exports.types` resolves for consumers.
      format: 'esm',
      bundle: false,
      dts: true,
      syntax: 'es2022',
      source: {
        entry: {
          index: [
            './src/**/*.ts',
            '!./src/hash-password.ts',
            '!./src/create-recovery.ts',
          ],
        },
        // Declarations follow this tsconfig, not the default one. The default
        // includes the tests so `typecheck` covers them, which widens tsc's
        // common source root to the package directory: the declarations land in
        // `dist/src/`, one level below where `exports` says the types are, and
        // the two config files pick up `.d.ts` files of their own.
        tsconfigPath: './tsconfig.build.json',
      },
    },
    {
      // The `bin` targets. No declarations: nothing imports a CLI, and a
      // `hash-password.d.ts` would only invite someone to try.
      format: 'esm',
      bundle: false,
      dts: false,
      syntax: 'es2022',
      banner: { js: '#!/usr/bin/env node' },
      source: {
        entry: {
          index: ['./src/hash-password.ts', './src/create-recovery.ts'],
        },
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
