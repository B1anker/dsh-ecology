/** Share downloaded bytes, never writable package files or virtual stores. */
import { join } from 'node:path'
import { worldLineDir } from '../fs/paths.js'
import { labStoreDir } from './layout.js'
import type { LabManifest } from './manifest.js'

export function labStorePolicy(home: string, manifest: LabManifest) {
  const shared = manifest.packageStore === 'shared-copy-v1'
  const directory = shared
    ? join(worldLineDir(home), 'cache', 'pnpm-store')
    : labStoreDir(home, manifest.id)
  return installationStorePolicy(directory, shared)
}

export function installationStorePolicy(directory: string, shared = true) {
  const flags = ['--store-dir', directory]
  if (shared) {
    flags.push(
      '--package-import-method=clone-or-copy',
      '--side-effects-cache=false',
      '--verify-store-integrity=true',
      '--virtual-store-dir=node_modules/.pnpm',
      '--config.enable-global-virtual-store=false',
    )
  }
  return {
    directory,
    flags,
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      if (!shared) return { ...env }
      const result = { ...env }
      // Case variants inherited from shells must not compete with our overrides.
      const keys = new Set([
        'store_dir',
        'package_import_method',
        'side_effects_cache',
        'verify_store_integrity',
        'virtual_store_dir',
        'enable_global_virtual_store',
      ])
      for (const key of Object.keys(result)) {
        const lower = key.toLowerCase()
        const prefix = lower.startsWith('pnpm_config_') ? 'pnpm_config_' : 'npm_config_'
        if (lower.startsWith(prefix) && keys.has(lower.slice(prefix.length).replaceAll('-', '_'))) {
          delete result[key]
        }
      }
      // pnpm 11 renamed its environment prefix; support both generations.
      const values: Record<string, string> = {
        store_dir: directory,
        package_import_method: 'clone-or-copy',
        side_effects_cache: 'false',
        verify_store_integrity: 'true',
        virtual_store_dir: 'node_modules/.pnpm',
        enable_global_virtual_store: 'false',
      }
      for (const [key, value] of Object.entries(values)) {
        result[`npm_config_${key}`] = value
        result[`pnpm_config_${key}`] = value
      }
      return result
    },
  }
}
