import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, rs, test } from '@rstest/core'
import { runRescuePlugins, runRescueStart } from '../../src/commands/rescue.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

const { launch, install } = rs.hoisted(() => ({ launch: rs.fn(), install: rs.fn() }))
rs.mock('../../src/lab/launcher.js', () => ({ launchDsh: launch }))
rs.mock('../../src/lab/runner.js', () => ({ runCaptured: install }))

test('selected bundle is installed privately with its patch; unrelated bundle stays out', async () => {
  const home = await makeTempHome()
  try {
    const bin = await installFakeDsh(home)
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const source = join(home, 'plugin-source')
    await mkdir(source)
    const pkg = {
      name: '@fixture/selected',
      version: '1.0.0',
      files: ['index.js'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    await writeFile(join(source, 'package.json'), JSON.stringify(pkg))
    await writeFile(join(source, 'index.js'), 'export const name = "fixture"')
    await writeFile(
      join(source, 'cordis.patch.yml'),
      '- insert:\n    - id: selected\n      name: "@fixture/selected"\n',
    )
    const profile = await writeProfile(home, 'web', {
      packageJson: JSON.stringify({
        private: true,
        dependencies: { '@fixture/selected': `file:${source}`, '@fixture/other': '1.0.0' },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              '@fixture/selected',
              '@fixture/other',
            ],
          },
        },
      }),
      patchYaml:
        '- id: selected\n  config:\n    enabled: true\n- id: unrelated\n  config:\n    secret: not-copied\n',
    })
    for (const name of ['selected', 'other']) {
      const dir = join(profile, 'node_modules', '@fixture', name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ ...pkg, name: `@fixture/${name}` }),
      )
      await writeFile(
        join(dir, 'cordis.patch.yml'),
        `- insert:\n    - id: ${name}\n      name: "@fixture/${name}"\n`,
      )
    }
    const ctx = {
      cwd: home,
      home,
      env: { ...process.env, PATH: bin },
      profileName: 'web',
      json: false,
      breakStaleLock: false,
      now: () => new Date(),
    }
    expect((await runRescuePlugins(ctx)).plugins.map((p) => p.id)).toEqual([
      'bundle:@fixture/selected',
      'bundle:@fixture/other',
      'unrelated',
    ])
    install.mockResolvedValue({ exitCode: 0 })
    launch.mockImplementation(async ({ cwd }: { cwd: string }) => {
      const dir = join(cwd, 'profiles/web')
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      expect(manifest.dsh.profile.bundles).toEqual([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@fixture/selected',
      ])
      expect(Object.keys(manifest.dependencies)).toEqual(['@fixture/selected'])
      const frozen = manifest.dependencies['@fixture/selected'].slice(5)
      expect(frozen).not.toBe(source)
      expect(JSON.parse(await readFile(join(frozen, 'package.json'), 'utf8')).files).toContain(
        './cordis.patch.yml',
      )
      expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('id: selected')
      expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).not.toContain('not-copied')
      return { kind: 'failed', detail: 'fixture' }
    })
    await runRescueStart(ctx, ['bundle:@fixture/selected'])
    expect(launch).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0]?.[1]).toContain('--ignore-scripts')
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).files).toEqual([
      'index.js',
    ])
  } finally {
    await destroyTempHome(home)
  }
})
