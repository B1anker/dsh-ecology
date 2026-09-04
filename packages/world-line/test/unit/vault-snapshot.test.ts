/**
 * Receipts, the snapshot analysis pass, and the vault store end to end.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import { InvariantError } from '../../src/domain/errors.js'
import { computeReceipt, receiptFromHashes } from '../../src/domain/receipt.js'
import type { SnapshotManifest } from '../../src/domain/snapshot.js'
import { analyzeProfile, buildManifest, newSnapshotId } from '../../src/domain/snapshot.js'
import { parseDshVersion } from '../../src/host-adapters/detect.js'
import { adapterDsh01x } from '../../src/host-adapters/dsh-0.1.x.js'
import {
  latestSnapshotFor,
  listSnapshotManifests,
  readSnapshotManifest,
  writeSnapshotManifest,
} from '../../src/vault/manifests.js'
import { putObject, readObject } from '../../src/vault/objects.js'
import { readState, writeState } from '../../src/vault/state.js'
import { makeTempHome, profilePackageJson, writeProfile } from '../helpers/fixture.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wl-test-'))
}

describe('receipts', () => {
  test('computeReceipt hashes the managed files deterministically', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'package.json'), profilePackageJson())
      await writeFile(join(dir, 'cordis.patch.yml'), '- id: a\n')
      const receipt = await computeReceipt({
        profileDir: dir,
        fileNames: ['package.json', 'cordis.patch.yml'],
      })
      expect(receipt.algo).toBe('sha256')
      expect(receipt.tree).toHaveLength(64)
      const again = await computeReceipt({
        profileDir: dir,
        fileNames: ['package.json', 'cordis.patch.yml'],
      })
      expect(again.tree).toBe(receipt.tree)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a touched file changes the tree; ordering is canonical', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'package.json'), profilePackageJson())
      const first = await computeReceipt({ profileDir: dir, fileNames: ['package.json'] })
      await writeFile(
        join(dir, 'package.json'),
        profilePackageJson({ bundles: ['@deepseek-ai/dsh-base'] }),
      )
      const second = await computeReceipt({ profileDir: dir, fileNames: ['package.json'] })
      expect(second.tree).not.toBe(first.tree)
      const canonical = receiptFromHashes({ b: 'x'.repeat(64), a: 'y'.repeat(64) })
      expect(Object.keys(canonical.files)).toEqual(['a', 'b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('analyzeProfile', () => {
  test('captures whitelist files, receipt, and derived-root state', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      const roles = analysis.files.map((record) => record.role).sort()
      expect(roles).toEqual(['manifest', 'profile-patch', 'workspace'])
      expect(analysis.layout.absent).toContain('lockfile')
      const manifest = analysis.files.find((record) => record.role === 'manifest')
      expect(manifest?.name).toBe('package.json')
      expect(manifest?.object).toBe(manifest?.sha256)
      expect(analysis.manifest?.bundles).toEqual([
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
      ])
      expect(analysis.derivedRoot.present).toBe(true)
      expect(analysis.derivedRoot.clean).toBe(true)
      expect(analysis.receipt.tree).toHaveLength(64)
      expect(analysis.unmanaged).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('flags secret-bearing files without storing them', async () => {
    const home = await makeTempHome()
    try {
      const stored: string[] = []
      await writeProfile(home, 'web', {
        patchYaml: '- id: gate\n  config:\n    apiKey: sk-1234567890abcdef\n',
      })
      const analysis = await analyzeProfile({
        home,
        profileName: 'web',
        adapter: adapterDsh01x,
        store: async (name: string) => {
          stored.push(name)
        },
      })
      const patch = analysis.files.find((record) => record.role === 'profile-patch')
      expect(patch?.secretSkipped).toBe(true)
      expect(stored).not.toContain('cordis.patch.yml')
      expect(JSON.stringify(patch?.entries)).toContain('<redacted>')
      expect(JSON.stringify(patch?.entries)).not.toContain('sk-1234567890abcdef')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('records parse errors instead of failing', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web', { packageJson: '{broken json' })
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      expect(analysis.manifest).toBeNull()
      expect(analysis.manifestParseError).not.toBeNull()
      expect(analysis.dependencies).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('resolves link dependencies with local receipts', async () => {
    const home = await makeTempHome()
    const plugin = await tempDir()
    try {
      await writeFile(
        join(plugin, 'package.json'),
        JSON.stringify({
          name: 'fixture-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      )
      await writeFile(join(plugin, 'cordis.patch.yml'), '- id: fixture\n')
      await writeProfile(home, 'web', {
        packageJson: profilePackageJson({
          dependencies: { 'fixture-plugin': `link:${plugin}` },
        }),
      })
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      const dep = analysis.dependencies.find((entry) => entry.name === 'fixture-plugin')
      expect(dep?.kind).toBe('link')
      expect(dep?.targetExists).toBe(true)
      expect(dep?.contentHash).toHaveLength(64)
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(plugin, { recursive: true, force: true })
    }
  })

  test('detects a dirty derived root config', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web', { cordisYml: '- id: baked-in-row\n' })
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      expect(analysis.derivedRoot.clean).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('vault objects and manifests', () => {
  test('objects dedupe by content and verify on read', async () => {
    const home = await makeTempHome()
    try {
      const first = await putObject(home, 'payload')
      const second = await putObject(home, 'payload')
      expect(first.sha256).toBe(second.sha256)
      expect(first.stored).toBe(true)
      expect(second.stored).toBe(false)
      expect((await readObject(home, first.sha256)).toString()).toBe('payload')
      await mkdir(join(home, 'world-line', 'vault', 'objects'), { recursive: true })
      const corruptPath = join(home, 'world-line', 'vault', 'objects', 'f'.repeat(64))
      await writeFile(corruptPath, 'not the right hash')
      await expect(readObject(home, 'f'.repeat(64))).rejects.toThrow(InvariantError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('snapshot manifests are immutable and listed in order', async () => {
    const home = await makeTempHome()
    try {
      const one = sampleManifest(home, 'snap-20260101T000000Z-aaaaaaaa', '2026-01-01T00:00:00.000Z')
      const two = sampleManifest(home, 'snap-20260102T000000Z-bbbbbbbb', '2026-01-02T00:00:00.000Z')
      await writeSnapshotManifest(home, one)
      await writeSnapshotManifest(home, two)
      await expect(writeSnapshotManifest(home, one)).rejects.toThrow(InvariantError)
      const { snapshots, corrupt } = await listSnapshotManifests(home)
      expect(corrupt).toEqual([])
      expect(snapshots.map((manifest) => manifest.id)).toEqual([
        'snap-20260101T000000Z-aaaaaaaa',
        'snap-20260102T000000Z-bbbbbbbb',
      ])
      expect(await latestSnapshotFor(home, 'web')).toBe('snap-20260102T000000Z-bbbbbbbb')
      const back = await readSnapshotManifest(home, 'snap-20260101T000000Z-aaaaaaaa')
      expect(back.profile.name).toBe('web')
      await writeFile(
        join(home, 'world-line', 'vault', 'snapshots', 'snap-20260103T000000Z-cccccccc.json'),
        '{not json',
      )
      const after = await listSnapshotManifests(home)
      expect(after.corrupt).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('store state round trips and refuses newer formats', async () => {
    const home = await makeTempHome()
    try {
      expect((await readState(home)).lastSnapshots).toEqual({})
      await writeState(home, {
        formatVersion: 1,
        createdAt: null,
        updatedAt: null,
        lastSnapshots: {},
      })
      const state = await readState(home)
      expect(state.updatedAt).not.toBeNull()
      await writeFile(join(home, 'world-line', 'state.json'), JSON.stringify({ formatVersion: 99 }))
      await expect(readState(home)).rejects.toThrow(InvariantError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('host version detection', () => {
  test('parses dsh version strings', () => {
    expect(parseDshVersion('0.1.2-rc.1\n')?.core).toEqual({ major: 0, minor: 1, patch: 2 })
    expect(parseDshVersion('v1.2.3\n')?.prerelease).toBeNull()
    expect(parseDshVersion('not a version')).toBeNull()
  })

  test('adapter verdict accepts only exercised versions', () => {
    const known = adapterDsh01x.verdict(parseDshVersion('0.1.2-rc.1'))
    expect(known.known).toBe(true)
    const other = adapterDsh01x.verdict(parseDshVersion('0.1.3'))
    expect(other.known).toBe(false)
    const missing = adapterDsh01x.verdict(null, true)
    expect(missing.known).toBe(false)
    expect(missing.undetectable).toBe(true)
  })
})

describe('manifest assembly', () => {
  test('buildManifest maps analysis into a persisted shape', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      const now = new Date('2026-01-01T00:00:00Z')
      const manifest = buildManifest({
        analysis,
        home,
        id: newSnapshotId(now),
        createdAt: now.toISOString(),
        label: 'before test',
        parentId: null,
        dsh: { cliVersion: '0.1.2-rc.1', known: true, adapterId: 'dsh-0.1.x' },
        nodeVersion: 'v22.0.0',
        os: 'darwin 1.0',
        arch: 'arm64',
      })
      expect(manifest.formatVersion).toBe(1)
      expect(manifest.kind).toBe('profile-snapshot')
      expect(manifest.label).toBe('before test')
      expect(manifest.derived.rootConfigPresent).toBe(true)
      expect(manifest.derived.rootConfigClean).toBe(true)
      expect(manifest.profile.receipt.tree).toHaveLength(64)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

/** A minimal valid manifest for vault tests. */
function sampleManifest(home: string, id: string, createdAt: string): SnapshotManifest {
  return {
    formatVersion: 1,
    kind: 'profile-snapshot',
    id,
    createdAt,
    label: null,
    parentId: null,
    action: 'snapshot',
    candidateSource: null,
    validation: null,
    retention: null,
    createdBy: {
      worldLineVersion: '0.1.0',
      environment: { node: 'v22', os: 'x', arch: 'y' },
    },
    dsh: { cliVersion: null, known: false, adapterId: null },
    profile: {
      name: 'web',
      dshHome: home,
      receipt: { algo: 'sha256', files: {}, tree: '0'.repeat(64) },
      manifest: { name: 'dsh-profile-web', bundles: [], patchReload: null },
      dependencies: [],
    },
    files: [],
    homePatch: null,
    derived: { rootConfigPresent: false, rootConfigClean: null },
    unmanaged: [],
  }
}
