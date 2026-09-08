import { expect, test } from '@rstest/core'
import { localPluginPath, pluginInstallSpec } from '../../src/client/plugin-input.js'

test('registry inputs default to latest without confusing the scoped name prefix', () => {
  for (const name of ['my-plugin', '@scope/plugin'])
    expect(pluginInstallSpec('registry', name).spec).toBe(name + '@latest')
  for (const version of ['0.5.0', 'latest', 'beta', '^0.5.0'])
    expect(pluginInstallSpec('registry', '@scope/plugin@' + version).spec).toBe(
      '@scope/plugin@' + version,
    )
  expect(pluginInstallSpec('registry', '@scope').error).toBeTruthy()
})
test('local directory inputs and pasted dependency specs become file dependencies', () => {
  for (const path of [
    '/Users/dev/My Plugin',
    'file:/Users/dev/My Plugin',
    '@file:/Users/dev/My Plugin',
    'link:/Users/dev/My Plugin',
  ]) {
    expect(localPluginPath(path)).toBe('/Users/dev/My Plugin')
    expect(pluginInstallSpec('local', path).spec).toBe('file:/Users/dev/My Plugin')
  }
  expect(pluginInstallSpec('local', 'relative/path').error).toBeTruthy()
  expect(pluginInstallSpec('local', '').spec).toBe('')
})
