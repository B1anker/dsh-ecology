import { defineConfig } from '@rslib/core'

export default defineConfig({
  lib: [
    {
      format: 'esm',
      bundle: false,
      dts: true,
      syntax: 'es2022',
      source: {
        entry: {
          index: ['./src/**/*.ts', '!./src/client.ts'],
        },
        tsconfigPath: './tsconfig.build.json',
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
      autoExtension: false,
      banner: {
        js: 'window.__ModuleLoader__.load({\n  id: "@seaveyon/dsh-git-worktree",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;',
      },
      footer: { js: '    return module.exports;\n  },\n});' },
      source: { entry: { client: './src/client.ts' } },
      // Keep React and DSH primitives in the shell's module table. A second
      // React copy would make the primitives' hooks incompatible with the
      // renderer that owns the page.
      output: {
        target: 'web',
        externals: ['react', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  ],
  output: {
    distPath: { root: './dist' },
    cleanDistPath: true,
  },
})
