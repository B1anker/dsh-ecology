/**
 * Local dependency bridging tests: relative file:/link: specs (and pnpm's
 * normalized relative lockfile entries) must keep resolving after a lab
 * clone, via in-lab symlinks to the real source dirs — with missing,
 * in-profile, and lab-escaping targets left alone.
 */

import { lstat, mkdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import { runSnapshotCreate } from '../../src/commands/snapshot.js'
import type { CliContext } from '../../src/context.js'
import { createLab } from '../../src/lab/create.js'
import type { KnownHost } from '../../src/lab/gate.js'
import { labExists } from '../../src/lab/layout.js'
import { linkLocalDeps, lockfileLocalDeps, packageJsonLocalDeps } from '../../src/lab/local-deps.js'
import { rmLab } from '../../src/lab/run.js'
import { snapshotSource } from '../../src/lab/snapshot-source.js'
import {
  destroyTempHome,
  makeTempHome,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const context = (home: string): CliContext => ({
  home,
  cwd: home,
  profileName: 'web',
  env: { WORLD_LINE_DISABLE_KEYCHAIN: '1', PATH: '' },
  json: true,
  breakStaleLock: false,
  now: () => new Date(),
})
const host = { adapterId: 'fixture', raw: '0.1.2-rc.1' } as KnownHost

/** Lockfile with relative file:/link: specifier+version rows and a resolution directory. */
const LOCAL_LOCKFILE = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      local-pkg:
        specifier: file:../../shared/pkg
        version: file:../../shared/pkg
      link-pkg:
        specifier: link:../../shared/linked
        version: link:../../shared/linked
      gone-pkg:
        specifier: file:../../shared/gone
        version: file:../../shared/gone

packages:
  link-pkg@link:../../shared/linked:
    resolution:
      directory: ../../shared/linked
`

/** Create the real local package dirs a relative-dep fixture points at. */
async function writeLocalPackages(home: string): Promise<{ pkg: string; linked: string }> {
  const pkg = join(home, 'shared', 'pkg')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), '{"name":"local-pkg","version":"1.0.0"}\n')
  const linked = join(home, 'shared', 'linked')
  await mkdir(linked, { recursive: true })
  await writeFile(join(linked, 'package.json'), '{"name":"link-pkg","version":"1.0.0"}\n')
  return { pkg, linked }
}

/** Profile with a relative file: dep in the manifest and the local lockfile. */
async function writeLocalDepProfile(home: string): Promise<void> {
  await writeProfile(home, 'web', {
    packageJson: profilePackageJson({ dependencies: { 'local-pkg': 'file:../../shared/pkg' } }),
    lockfile: LOCAL_LOCKFILE,
  })
}

describe('local dependency scanning', () => {
  test('packageJsonLocalDeps collects relative file:/link: specs from all dep sections', () => {
    const text = JSON.stringify({
      dependencies: {
        a: 'file:../a',
        b: 'link:../../b',
        c: 'file:/abs/c',
        d: '^1.0.0',
      },
      devDependencies: { e: 'file:./e' },
      optionalDependencies: { f: 'link:../f' },
    })
    expect(packageJsonLocalDeps(text).toSorted()).toEqual(['../../b', '../a', '../f', './e'])
    expect(packageJsonLocalDeps('not json')).toEqual([])
    expect(packageJsonLocalDeps('42')).toEqual([])
  })

  test('lockfileLocalDeps covers specifier/version/package keys and resolution directory', () => {
    // pkg ×2 (specifier+version), gone ×2, linked ×4 (specifier, version,
    // the `packages:` key — trailing colon excluded — and resolution directory).
    expect(lockfileLocalDeps(LOCAL_LOCKFILE).toSorted()).toEqual([
      '../../shared/gone',
      '../../shared/gone',
      '../../shared/linked',
      '../../shared/linked',
      '../../shared/linked',
      '../../shared/linked',
      '../../shared/pkg',
      '../../shared/pkg',
    ])
    expect(lockfileLocalDeps('version: 1.0.0\nresolution:\n  integrity: sha512-x\n')).toEqual([])
  })
})

describe('linkLocalDeps', () => {
  test('links relative targets into the lab, skipping missing, in-profile, and escaping paths', async () => {
    const home = await makeTempHome()
    try {
      const { pkg, linked } = await writeLocalPackages(home)
      const sourceProfileDir = join(home, 'profiles', 'web')
      await mkdir(sourceProfileDir, { recursive: true })
      // A target nested inside the source profile (in-profile rels are skipped).
      await mkdir(join(sourceProfileDir, 'nested', 'inner'), { recursive: true })
      const labProfileDir = join(
        home,
        'world-line',
        'labs',
        'lab-20260904T000000Z-deadbeef',
        'home',
        'profiles',
        'web',
      )
      await mkdir(labProfileDir, { recursive: true })
      // Pre-existing real dir at a would-be link location: never overwritten.
      const occupied = resolve(labProfileDir, '../../shared/linked')
      await mkdir(occupied, { recursive: true })
      await writeFile(
        join(labProfileDir, 'package.json'),
        JSON.stringify({
          dependencies: {
            'local-pkg': 'file:../../shared/pkg',
            'link-pkg': 'link:../../shared/linked',
            'gone-pkg': 'file:../../shared/gone',
            'inner-pkg': 'file:./nested/inner',
            'escape-pkg': 'file:../../../../escape/pkg',
          },
        }),
      )

      const summary = await linkLocalDeps(sourceProfileDir, labProfileDir)
      expect(summary.linked).toEqual(['../../shared/pkg'])
      expect(summary.missing).toEqual(['../../shared/gone'])

      const pkgLink = resolve(labProfileDir, '../../shared/pkg')
      expect((await lstat(pkgLink)).isSymbolicLink()).toBe(true)
      expect(await readlink(pkgLink)).toBe(pkg)
      expect(await realpath(pkgLink)).toBe(await realpath(pkg))

      // Occupied path stayed a real directory.
      expect((await lstat(occupied)).isSymbolicLink()).toBe(false)
      expect((await lstat(occupied)).isDirectory()).toBe(true)
      expect((await realpath(occupied)).startsWith(await realpath(linked))).toBe(false)

      // In-profile and escaping rels created nothing.
      await expect(lstat(join(labProfileDir, 'nested'))).rejects.toThrow()
      await expect(lstat(join(home, 'world-line', 'labs', 'escape'))).rejects.toThrow()
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('createLab local dependency bridging', () => {
  test('clone path: relative file:/link: deps resolve inside the lab; rmLab keeps the targets', async () => {
    const home = await makeTempHome()
    const ctx = context(home)
    try {
      const { pkg, linked } = await writeLocalPackages(home)
      await writeLocalDepProfile(home)
      const created = await createLab(ctx, host, 'web')

      const pkgLink = resolve(created.labProfileDir, '../../shared/pkg')
      expect((await lstat(pkgLink)).isSymbolicLink()).toBe(true)
      expect(await realpath(pkgLink)).toBe(await realpath(pkg))
      const linkedLink = resolve(created.labProfileDir, '../../shared/linked')
      expect((await lstat(linkedLink)).isSymbolicLink()).toBe(true)
      expect(await realpath(linkedLink)).toBe(await realpath(linked))
      // The missing target is skipped (install fails later, as without bridging).
      await expect(lstat(resolve(created.labProfileDir, '../../shared/gone'))).rejects.toThrow()

      // Cleanup unlinks the symlinks instead of following them.
      await rmLab(home, created.manifest.id)
      expect(await labExists(home, created.manifest.id)).toBe(false)
      expect((await lstat(pkg)).isDirectory()).toBe(true)
      expect((await lstat(linked)).isDirectory()).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('restore path: snapshot-materialized labs get the same symlinks', async () => {
    const home = await makeTempHome()
    const ctx = context(home)
    try {
      const { pkg } = await writeLocalPackages(home)
      await writeLocalDepProfile(home)
      const saved = await runSnapshotCreate(ctx, { label: 'local deps' })
      const source = await snapshotSource(ctx, saved.id)
      const branch = await createLab(ctx, host, 'web', { source })
      expect(branch.manifest.source.kind).toBe('restore')
      const pkgLink = resolve(branch.labProfileDir, '../../shared/pkg')
      expect((await lstat(pkgLink)).isSymbolicLink()).toBe(true)
      expect(await realpath(pkgLink)).toBe(await realpath(pkg))
      const linkedLink = resolve(branch.labProfileDir, '../../shared/linked')
      expect((await lstat(linkedLink)).isSymbolicLink()).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })
})
