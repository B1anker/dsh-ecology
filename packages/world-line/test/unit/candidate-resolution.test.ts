import { expect, test } from '@rstest/core'
import { pnpmArgsFor } from '../../src/lab/run.js'
import { installationStorePolicy } from '../../src/lab/store.js'

test('bare registry installation explicitly replaces a prior local resolution with latest', () => {
  expect(pnpmArgsFor({ seq: 1, action: 'add', spec: '@scope/plugin' }, [], false)).toEqual([
    'add',
    '@scope/plugin@latest',
    '--ignore-scripts',
  ])
  expect(pnpmArgsFor({ seq: 1, action: 'add', spec: '@scope/plugin@0.5.0' }, [], false)[1]).toBe(
    '@scope/plugin@0.5.0',
  )
  expect(pnpmArgsFor({ seq: 1, action: 'add', spec: 'file:/tmp/plugin' }, [], false)[1]).toBe(
    'file:/tmp/plugin',
  )
})

test('shared-store configuration uses remove-compatible pnpm options without weakening isolation', () => {
  const policy = installationStorePolicy('/tmp/fixture-store')
  const args = pnpmArgsFor({ seq: 1, action: 'remove', id: '@scope/plugin' }, policy.flags, false)
  expect(args.slice(0, 2)).toEqual(['remove', '@scope/plugin'])
  expect(args).toContain('--config.side-effects-cache=false')
  expect(args).toContain('--config.verify-store-integrity=true')
  expect(args).toContain('--package-import-method=clone-or-copy')
  expect(args).not.toContain('--side-effects-cache=false')
  expect(args).not.toContain('--verify-store-integrity=true')
  expect(policy.environment({ npm_config_side_effects_cache: 'true' })).toMatchObject({
    npm_config_side_effects_cache: 'false',
    pnpm_config_verify_store_integrity: 'true',
  })
})
