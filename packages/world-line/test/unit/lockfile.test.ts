/**
 * pnpm lockfile parsing and dependency resolution (the lockfile is what ties
 * a manifest's registry specs to concrete versions at snapshot time).
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import { parsePnpmLockfile, resolveDependency } from '../../src/domain/lockfile.js'
import { analyzeProfile } from '../../src/domain/snapshot.js'
import { adapterDsh01x } from '../../src/host-adapters/dsh-0.1.x.js'
import {
  makeTempHome,
  minimalLockfile,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

describe('parsePnpmLockfile', () => {
  test('parses lockfileVersion 9 documents', () => {
    const lockfile = parsePnpmLockfile(minimalLockfile('lodash', '4.17.21'))
    expect(lockfile).not.toBeNull()
    expect(lockfile?.packages.get('/lodash@4.17.21')?.resolution?.integrity).toContain('sha512-')
  })

  test('returns null for invalid text and non-object roots', () => {
    expect(parsePnpmLockfile('{oops')).toBeNull()
    expect(parsePnpmLockfile('[]')).toBeNull()
    expect(parsePnpmLockfile('')).toBeNull()
  })
})

describe('resolveDependency', () => {
  test('resolves real v9 keys and peer suffixes without guessing a different version', () => {
    const lock = parsePnpmLockfile(`lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@scope/plugin':
        specifier: ^1.2.0
        version: 1.2.3(react@19.0.0)
packages:
  '@scope/plugin@1.2.3':
    resolution: {integrity: sha512-verified}
  '@scope/plugin@2.0.0':
    resolution: {integrity: sha512-other}
`)
    expect(resolveDependency(lock!, '@scope/plugin')).toEqual({
      version: '1.2.3',
      integrity: 'sha512-verified',
    })
    lock!.importer['@scope/plugin']!.version = '9.0.0'
    expect(resolveDependency(lock!, '@scope/plugin')).toBeUndefined()
  })
  test('finds the importer version first, then the package entry', () => {
    const lockfile = parsePnpmLockfile(minimalLockfile('lodash', '4.17.21'))
    expect(lockfile).not.toBeNull()
    const resolved = resolveDependency(lockfile!, 'lodash')
    expect(resolved?.version).toBe('4.17.21')
    expect(resolved?.integrity).toContain('sha512-')
    expect(resolveDependency(lockfile!, 'missing-package')).toBeUndefined()
  })
})

describe('lockfile participation in profile analysis', () => {
  test('resolved versions land on registry dependencies', async () => {
    const home = await makeTempHome()
    try {
      const lockfile = minimalLockfile('@seaveyon/dsh-pet', '0.2.0')
      const profileDir = await writeProfile(home, 'web', { lockfile })
      // The manifest must actually declare the dependency for the importer to
      // carry it; write a matching manifest over the fixture default.
      await writeFile(
        join(profileDir, 'package.json'),
        profilePackageJson({
          dependencies: { '@seaveyon/dsh-pet': '^0.2.0' },
        }),
      )
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      const dep = analysis.dependencies.find((entry) => entry.name === '@seaveyon/dsh-pet')
      expect(dep?.kind).toBe('registry')
      expect(dep?.resolved?.version).toBe('0.2.0')
      const lockRecord = analysis.files.find((record) => record.role === 'lockfile')
      expect(lockRecord?.name).toBe('pnpm-lock.yaml')
      expect(lockRecord?.parseError).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('a malformed lockfile is recorded, not fatal', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web', { lockfile: '{broken lockfile' })
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      const lockRecord = analysis.files.find((record) => record.role === 'lockfile')
      expect(lockRecord?.parseError).not.toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
