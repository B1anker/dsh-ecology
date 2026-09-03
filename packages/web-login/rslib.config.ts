import { pluginReact } from '@rsbuild/plugin-react'
import { defineConfig } from '@rslib/core'

/**
 * Build configuration.
 *
 * Three entries:
 * 1. Host library (bundleless ESM + declarations) for the Cordis gate.
 * 2. CLI bins with a shebang.
 * 3. Browser client bundle for the shell settings panel, wrapped in the
 *    `__ModuleLoader__.load` envelope the DSH client module system requires.
 */
export default defineConfig({
  lib: [
    {
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
            '!./src/client/**',
          ],
        },
        tsconfigPath: './tsconfig.build.json',
      },
      output: {
        target: 'node',
      },
    },
    {
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
      output: {
        target: 'node',
      },
    },
    {
      format: 'cjs',
      bundle: true,
      dts: false,
      syntax: 'es2022',
      // Package is `"type": "module"`; keep the output named `client.js`.
      autoExtension: false,
      banner: {
        js: 'window.__ModuleLoader__.load({\n  id: "@seaveyon/dsh-web-login",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;',
      },
      footer: {
        js: '    return module.exports;\n  },\n});',
      },
      source: {
        entry: {
          client: './src/client/index.ts',
        },
      },
      plugins: [pluginReact()],
      output: {
        target: 'web',
        externals: ['react', 'react-dom', 'react/jsx-runtime'],
      },
    },
  ],
  output: {
    distPath: { root: './dist' },
    cleanDistPath: true,
  },
})
