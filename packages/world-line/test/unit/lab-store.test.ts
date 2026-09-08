import { expect, test } from '@rstest/core'
import { type LabManifest, labManifestOf } from '../../src/lab/manifest.js'
import { labStorePolicy } from '../../src/lab/store.js'

const id = 'lab-20260908T010203Z-1234abcd'
const manifest = { id, manifestVersion: 1, state: 'created' } as LabManifest

test('legacy manifests keep their original store and environment', () => {
  const policy = labStorePolicy('/manager', manifest)
  expect(policy.flags).toEqual(['--store-dir', `/manager/world-line/labs/${id}/pnpm-store`])
  expect(policy.environment({ CUSTOM: 'value' })).toEqual({ CUSTOM: 'value' })
})
test('new labs share downloads but pin independent writable installations', () => {
  const policy = labStorePolicy('/manager', { ...manifest, packageStore: 'shared-copy-v1' })
  const other = labStorePolicy('/manager', {
    ...manifest,
    id: 'lab-20260908T010203Z-2345abcd',
    packageStore: 'shared-copy-v1',
  })
  expect(policy.directory).toBe(other.directory)
  expect(policy.flags).toContain('--package-import-method=clone-or-copy')
  expect(policy.flags).toContain('--virtual-store-dir=node_modules/.pnpm')
  const env = policy.environment({
    NPM_CONFIG_PACKAGE_IMPORT_METHOD: 'hardlink',
    PNPM_CONFIG_STORE_DIR: '/external',
    npm_config_store_dir: '/formal',
    CUSTOM: 'kept',
  })
  expect(env.NPM_CONFIG_PACKAGE_IMPORT_METHOD).toBeUndefined()
  expect(env.PNPM_CONFIG_STORE_DIR).toBeUndefined()
  expect(env.pnpm_config_store_dir).toBe(policy.directory)
  expect(env.pnpm_config_package_import_method).toBe('clone-or-copy')
  expect(env.npm_config_store_dir).toBe(policy.directory)
  expect(env.npm_config_package_import_method).toBe('clone-or-copy')
  expect(env.npm_config_side_effects_cache).toBe('false')
  expect(env.CUSTOM).toBe('kept')
  expect(
    labStorePolicy('/different', { ...manifest, packageStore: 'shared-copy-v1' }).directory,
  ).not.toBe(policy.directory)
})
test('unknown store policy fails closed', () => {
  expect(() => labManifestOf({ ...manifest, packageStore: 'future' }, id)).toThrow(
    'unsupported package store policy',
  )
})
