import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import { runLabStart } from '../../src/commands/lab-service.js'
import { createCleanLab } from '../../src/lab/clean.js'
import { requireKnownHost } from '../../src/lab/gate.js'
import { mergePackage } from '../../src/web/merge.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

async function setup() {
  const home = await makeTempHome()
  const bin = await installFakeDsh(home)
  const ctx = {
    home,
    cwd: home,
    profileName: 'web',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    json: false,
    breakStaleLock: false,
    now: () => new Date(),
  }
  return { home, ctx, host: requireKnownHost(ctx) }
}

test('clean creation works without a source profile and uses the ordinary lab manifest', async () => {
  const { home, ctx, host } = await setup()
  try {
    const created = await createCleanLab(ctx, host, { sourceHome: home })
    expect(created.manifest.source.initialization).toBe('clean')
    expect(created.manifest.id).toMatch(/^lab-/)
    const pkg = JSON.parse(await readFile(join(created.labProfileDir, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toEqual({})
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(await readFile(join(created.labProfileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  } finally {
    await destroyTempHome(home)
  }
})

test('selected bundles default to fresh config; opt-in copies only matching rows', async () => {
  const { home, ctx, host } = await setup()
  try {
    const profile = await writeProfile(home, 'web', {
      packageJson: JSON.stringify({
        dependencies: { '@fixture/plugin': '1.0.0' },
        dsh: { profile: { bundles: ['@fixture/plugin'] } },
      }),
      patchYaml:
        '- id: fixture-plugin\n  disabled: true\n- id: unrelated\n  config:\n    secret: do-not-copy\n',
    })
    const dir = join(profile, 'node_modules/@fixture/plugin')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ version: '1.0.0', dsh: { bundle: { patch: './patch.yml' } } }),
    )
    await writeFile(
      join(dir, 'patch.yml'),
      '- insert:\n    - id: fixture-plugin\n      name: "@fixture/plugin"\n',
    )
    const fresh = await createCleanLab(ctx, host, {
      sourceHome: home,
      plugins: ['@fixture/plugin'],
    })
    expect(await readFile(join(fresh.labProfileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    const copied = await createCleanLab(ctx, host, {
      sourceHome: home,
      plugins: ['@fixture/plugin'],
      copyPluginConfig: true,
    })
    const patch = await readFile(join(copied.labProfileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('disabled: true')
    expect(patch).not.toContain('do-not-copy')
    await expect(
      createCleanLab(ctx, host, { sourceHome: home, plugins: ['unknown'] }),
    ).rejects.toThrow('没有 bundle')
    await expect(
      runLabStart(ctx, { new: true, clean: true, snapshotId: 'snapshot' }),
    ).rejects.toThrow('干净环境必须新建')
    await expect(runLabStart(ctx, { new: true, plugins: ['@fixture/plugin'] })).rejects.toThrow(
      '仅适用于干净环境',
    )
  } finally {
    await destroyTempHome(home)
  }
})

test('merging a clean profile does not remove unselected main plugins', () => {
  const main = { dependencies: { keep: '1' }, dsh: { profile: { bundles: ['keep'] } } }
  const clean = { dependencies: { added: '1' }, dsh: { profile: { bundles: ['added'] } } }
  expect(mergePackage(main, clean, ['added']).dependencies).toEqual({ keep: '1', added: '1' })
})
