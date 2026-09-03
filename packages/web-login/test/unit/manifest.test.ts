/**
 * Properties of the published manifest that only a consumer would notice.
 *
 * These assertions fail close to the source of a packaging mistake. The
 * tarball smoke test also resolves the public package name and bundle file, but
 * only after a full build and pack; keeping the manifest contract here makes a
 * missing export or bundle declaration a focused unit failure as well.
 *
 * @module test/unit/manifest
 */

import { readFile } from 'node:fs/promises'
import { expect, test } from '@rstest/core'

const manifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as {
  bin: Record<string, string>
  dsh: { bundle: { patch: string }; client?: { platform: string; inject: unknown[]; immediately: boolean } }
  exports: Record<string, unknown>
  files: string[]
}

test('the manifest exports itself', () => {
  // An `exports` map is a closed list: once it exists, every path not in it is
  // an ERR_PACKAGE_PATH_NOT_EXPORTED, including `<pkg>/package.json`. Plenty of
  // tooling reads that file to find a version or a root, so leaving it out
  // turns a routine lookup into a hard failure for reasons no consumer can see.
  expect(manifest.exports['./package.json']).toBe('./package.json')
})

test('the manifest declares and publishes an installable DSH bundle', async () => {
  const patch = manifest.dsh.bundle.patch
  expect(patch).toBe('./cordis.patch.yml')
  expect(manifest.files).toContain('cordis.patch.yml')
  expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')

  // Reading through the declared relative path catches the failure npm itself
  // does not: `npm pack` accepts a dsh.bundle.patch that points to no file.
  const contents = await readFile(new URL(`../../${patch}`, import.meta.url), 'utf8')
  expect(contents).toMatch(/^- insert:/m)
  expect(contents).toContain("name: '@seaveyon/dsh-web-login'")
})

test('the password CLI bin target exists in the built artifact', async () => {
  const target = manifest.bin['dsh-web-login-hash']
  expect(target).toBe('./dist/hash-password.js')
  await expect(readFile(new URL(`../../${target}`, import.meta.url), 'utf8')).resolves.toMatch(
    /^#!\/usr\/bin\/env node/,
  )
})

test('the recovery CLI bin target exists in the built artifact', async () => {
  const target = manifest.bin['dsh-web-login-recovery']
  expect(target).toBe('./dist/create-recovery.js')
  await expect(readFile(new URL(`../../${target}`, import.meta.url), 'utf8')).resolves.toMatch(
    /^#!\/usr\/bin\/env node/,
  )
})

test('the manifest declares a loadable web client', async () => {
  expect(manifest.dsh.client).toEqual({
    platform: 'web',
    inject: [],
    immediately: true,
  })
  expect(manifest.exports['./client']).toEqual({ default: './dist/client.js' })
  const client = await readFile(new URL('../../dist/client.js', import.meta.url), 'utf8')
  expect(client).toMatch(/__ModuleLoader__\.load/)
  expect(client).toContain('@seaveyon/dsh-web-login')
})
