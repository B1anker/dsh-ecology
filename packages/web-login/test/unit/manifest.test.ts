/**
 * Properties of the published manifest that only a consumer would notice.
 *
 * Nothing else in the pipeline covers these. `pack:check` proves the tarball
 * contains the files `files` lists, and the tarball smoke test imports the built
 * modules by path — but both reach past the `exports` map rather than through
 * it, which is the one part of the manifest that can deny access to a file that
 * is definitely there.
 *
 * @module test/unit/manifest
 */

import { readFile } from 'node:fs/promises'
import { expect, test } from '@rstest/core'

const manifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> }

test('the manifest exports itself', () => {
  // An `exports` map is a closed list: once it exists, every path not in it is
  // an ERR_PACKAGE_PATH_NOT_EXPORTED, including `<pkg>/package.json`. Plenty of
  // tooling reads that file to find a version or a root, so leaving it out
  // turns a routine lookup into a hard failure for reasons no consumer can see.
  expect(manifest.exports['./package.json']).toBe('./package.json')
})
