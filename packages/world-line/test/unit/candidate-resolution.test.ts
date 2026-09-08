import { expect, test } from '@rstest/core'
import { pnpmArgsFor } from '../../src/lab/run.js'

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
