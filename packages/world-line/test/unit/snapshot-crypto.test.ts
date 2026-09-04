/**
 * Encrypted capture tests (`snapshot create` + the Phase 4 secret vault):
 * with a key (env override) secret-bearing patch files are stored encrypted
 * in `vault/secrets/<id>.bin` and the manifest records the bundle digest;
 * without any key service they stay skipped with a warning and no `.bin`;
 * tampered bundles and wrong keys fail closed on restore reads.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import type { SnapshotManifest } from '../../src/domain/snapshot.js'
import { snapshotManifestPath } from '../../src/fs/paths.js'
import { readSecretBundleEntries } from '../../src/vault/secrets.js'
import {
  destroyTempHome,
  installFakeDsh,
  makeTempHome,
  runCliIn,
  writeProfile,
} from '../helpers/fixture.js'

const KEY = 'ab'.repeat(32)
const SECRET = 'sk-1234567890abcdef'
const PATCH = `- id: gate\n  config:\n    apiKey: ${SECRET}\n`

async function captureSnapshot(
  home: string,
  env: Record<string, string>,
): Promise<{ id: string; run: { exitCode: number; stdout: string } }> {
  const run = await runCliIn({
    argv: ['snapshot', 'create'],
    home,
    env: { WORLD_LINE_DISABLE_KEYCHAIN: '1', ...env },
  })
  expect(run.exitCode).toBe(0)
  const id = run.stdout.split('\n')[0]?.replace('snapshot  ', '')
  expect(id).toMatch(/^snap-/)
  return { id: id ?? '', run }
}

describe('encrypted secret capture', () => {
  test('with an env key, secret files are stored encrypted and digest-recorded', async () => {
    const home = await makeTempHome()
    try {
      await installFakeDsh(home)
      await writeProfile(home, 'web', { patchYaml: PATCH })
      const { id } = await captureSnapshot(home, { WORLD_LINE_SECRET_KEY: KEY })
      const manifest = JSON.parse(
        await readFile(snapshotManifestPath(home, id), 'utf8'),
      ) as SnapshotManifest
      expect(manifest.secretsBundle).not.toBeNull()
      expect(manifest.secretsBundle?.format).toBe('AES-256-GCM-v1')
      expect(manifest.secretsBundle?.entryCount).toBe(1)
      const patch = manifest.files.find((record) => record.role === 'profile-patch')
      expect(patch?.secretStored).toBe(true)
      expect(patch?.secretSkipped).toBe(false)
      // The plaintext must never appear anywhere on disk outside the bundle.
      const names = await readdir(join(home, 'world-line', 'vault', 'secrets'))
      expect(names).toEqual([`${id}.bin`])
      const bundleText = await readFile(
        join(home, 'world-line', 'vault', 'secrets', `${id}.bin`),
        'utf8',
      )
      expect(bundleText).not.toContain(SECRET)
      // Decrypt round trip.
      const entries = await readSecretBundleEntries(
        home,
        id,
        Buffer.from(KEY, 'hex'),
        manifest.secretsBundle?.sha256,
      )
      const patchBytes = entries.get('cordis.patch.yml')
      expect(patchBytes?.toString('utf8')).toContain(SECRET)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('without any key service, secret files stay skipped and no bundle is written', async () => {
    const home = await makeTempHome()
    try {
      await installFakeDsh(home)
      await writeProfile(home, 'web', { patchYaml: PATCH })
      const { id, run } = await captureSnapshot(home, {})
      expect(run.stdout).toMatch(/not stored/)
      const manifest = JSON.parse(
        await readFile(snapshotManifestPath(home, id), 'utf8'),
      ) as SnapshotManifest
      expect(manifest.secretsBundle).toBeNull()
      const patch = manifest.files.find((record) => record.role === 'profile-patch')
      expect(patch?.secretSkipped).toBe(true)
      const names = await readdir(join(home, 'world-line', 'vault', 'secrets')).catch(() => [])
      expect(names).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a tampered bundle fails its digest; a wrong key fails decryption', async () => {
    const home = await makeTempHome()
    try {
      await installFakeDsh(home)
      await writeProfile(home, 'web', { patchYaml: PATCH })
      const { id } = await captureSnapshot(home, { WORLD_LINE_SECRET_KEY: KEY })
      const manifest = JSON.parse(
        await readFile(snapshotManifestPath(home, id), 'utf8'),
      ) as SnapshotManifest
      const path = join(home, 'world-line', 'vault', 'secrets', `${id}.bin`)
      const bytes = await readFile(path)
      bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0xff
      await import('node:fs/promises').then(({ writeFile }) => writeFile(path, bytes))
      await expect(
        readSecretBundleEntries(home, id, Buffer.from(KEY, 'hex'), manifest.secretsBundle?.sha256),
      ).rejects.toThrow(/digest/)
      // Wrong key against the pristine bundle: AES-GCM auth failure.
      const fresh = await captureSnapshot(home, { WORLD_LINE_SECRET_KEY: KEY })
      const freshManifest = JSON.parse(
        await readFile(snapshotManifestPath(home, fresh.id), 'utf8'),
      ) as SnapshotManifest
      await expect(
        readSecretBundleEntries(
          home,
          fresh.id,
          Buffer.from('cd'.repeat(32), 'hex'),
          freshManifest.secretsBundle?.sha256,
        ),
      ).rejects.toThrow(/cannot be decrypted/)
    } finally {
      await destroyTempHome(home)
    }
  })
})
