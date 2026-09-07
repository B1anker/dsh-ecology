import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pluginReact } from '@rsbuild/plugin-react'
import { defineConfig } from '@rslib/core'
export default defineConfig({
  lib: [
    {
      format: 'cjs',
      bundle: true,
      dts: false,
      syntax: 'es2022',
      autoExtension: false,
      banner: {
        js: 'window.__ModuleLoader__.load({id:"@seaveyon/dsh-world-line",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
      },
      footer: { js: 'return module.exports;}});' },
      source: {
        entry: { client: './src/client/index.tsx' },
        define: {
          'process.env.NODE_ENV': JSON.stringify('production'),
          worldLineFlowCss: JSON.stringify(
            readFileSync(
              createRequire(import.meta.url).resolve('@xyflow/react/dist/base.css'),
              'utf8',
            ),
          ),
        },
      },
      tools: { rspack: { optimization: { nodeEnv: 'production' } } },
      plugins: [pluginReact()],
      output: { target: 'web', externals: ['react', 'react-dom', 'react/jsx-runtime'] },
    },
  ],
  // DSH loads one self-contained browser factory; never reuse cached dependency
  // transforms that still reference Node globals after changing browser defines.
  performance: { buildCache: false },
  output: { distPath: { root: './dist' }, cleanDistPath: false },
})
