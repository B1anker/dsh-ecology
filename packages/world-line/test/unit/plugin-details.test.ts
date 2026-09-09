import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import type { DependencyRecord } from '../../src/domain/snapshot.js'
import { pluginDetails } from '../../src/web/plugin-details.js'

test('plugin details resolve installed versions and expose only matching redacted config layers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wl-plugin-details-'))
  try {
    const profile = join(home, 'profiles/web'),
      root = join(profile, 'node_modules/@test/login')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@test/login',
        version: '0.6.0',
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }),
    )
    await writeFile(
      join(root, 'cordis.patch.yml'),
      '- insert:\n    - id: auth\n      name: "@test/login"\n      config:\n        port: 3000\n',
    )
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      '- id: auth\n  config:\n    port: 3080\n    apiKey: private-value\n- id: unrelated\n  config:\n    privateField: unrelated-data\n',
    )
    const result = await pluginDetails(
      { home, profileName: 'web' } as CliContext,
      [{ name: '@test/login' }] as DependencyRecord[],
    )
    expect(result[0]?.displayVersion).toBe('0.6.0')
    expect(result[0]?.configLayers).toHaveLength(2)
    const text = JSON.stringify(result)
    expect(text).toContain('3080')
    expect(text).toContain('<redacted>')
    expect(text).not.toContain('private-value')
    expect(text).not.toContain('unrelated-data')
    expect(result[0]?.configIncomplete).toBe(false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
