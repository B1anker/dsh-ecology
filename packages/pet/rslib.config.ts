import { pluginReact } from '@rsbuild/plugin-react'
import { defineConfig } from '@rslib/core'

/**
 * Build configuration.
 *
 * One entry, one file: the browser client bundle. The DSH client module system
 * serves it at `/plugins/@seaveyon/dsh-pet/client.js` and evaluates it in the
 * shell page, where it must call `window.__ModuleLoader__.load({ id, factory })`
 * exactly once. rslib has no output format for that envelope, so the CJS bundle
 * is wrapped by banner/footer: the banner opens the `load({...})` call and
 * provides the `module`/`exports` pair the CJS output assigns into, the footer
 * returns the exports from the factory. React stays external — the shell
 * resolves `require("react")` against its own static module table, and bundling
 * a second copy would break hook identity with the shell's renderer.
 */
export default defineConfig({
  lib: [
    {
      // The host face: the single launch-desktop route the Loader row
      // resolves to. ESM like every other package here, with declarations so
      // `exports["."]` types resolve.
      format: 'esm',
      bundle: false,
      dts: true,
      syntax: 'es2022',
      source: {
        entry: {
          index: './src/index.ts',
          desktop: './src/desktop.ts',
          // bundle:false emits entry files ONLY — index.js imports this at
          // runtime, so the launcher must be an entry or the published
          // package dangles (the trap desktop.ts's header documents).
          launch: './src/launch.ts',
        },
        tsconfigPath: './tsconfig.build.json',
      },
    },
    {
      format: 'cjs',
      bundle: true,
      dts: false,
      syntax: 'es2022',
      // The package is `"type": "module"`, which would name the CJS output
      // `client.cjs`; the exports map and the shell both expect `client.js`.
      autoExtension: false,
      banner: {
        // The id must equal the Loader entry name (the scoped package name):
        // the shell's module loader rejects a bundle that registers anything
        // else with "loaded without registering <id>".
        js: 'window.__ModuleLoader__.load({\n  id: "@seaveyon/dsh-pet",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;',
      },
      footer: {
        js: '    return module.exports;\n  },\n});',
      },
      source: {
        entry: {
          client: './src/client/index.ts',
        },
      },
      // rslib ships no React handling of its own: without this plugin SWC's
      // default classic runtime emits `React.createElement` with no `React`
      // binding in scope, which only detonates inside the shell at render
      // time. The plugin selects the automatic runtime (`react/jsx-runtime`),
      // which the externals below hand to the shell's module table.
      plugins: [pluginReact()],
      output: {
        externals: ['react', 'react-dom', 'react/jsx-runtime'],
      },
    },
  ],
  output: {
    target: 'web',
    distPath: { root: './dist' },
    // Rewriting the whole directory on each build guarantees that a module
    // deleted from src cannot survive in dist and keep resolving.
    cleanDistPath: true,
  },
})
