import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import { isolateLocalDependencies } from '../../src/commands/lab-service.js'
import type { CliContext } from '../../src/context.js'
import { labDir, labProfileDir } from '../../src/lab/layout.js'

test('branch local dependency replaces bridge symlink with an independent copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wl-branch-copy-'))
  const id = 'lab-20260908T075114Z-9bd97213'
  try {
    const source = join(home, 'source-plugin'),
      destination = join(labDir(home, id), 'local-packages', '0')
    const profile = labProfileDir(home, id, 'web')
    await mkdir(source, { recursive: true })
    await mkdir(profile, { recursive: true })
    await mkdir(join(labDir(home, id), 'local-packages'), { recursive: true })
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        files: [],
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }),
    )
    await writeFile(join(source, 'cordis.patch.yml'), '[]')
    const before = await readFile(join(source, 'package.json'), 'utf8')
    await symlink(source, destination)
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: { fixture: `file:${source}` } }),
    )
    await isolateLocalDependencies({ home, profileName: 'web' } as CliContext, id)
    expect((await lstat(destination)).isSymbolicLink()).toBe(false)
    expect(await readFile(join(source, 'package.json'), 'utf8')).toBe(before)
    expect(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).files).toContain(
      'cordis.patch.yml',
    )
    expect(
      JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies.fixture,
    ).toBe(`file:${destination}`)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
