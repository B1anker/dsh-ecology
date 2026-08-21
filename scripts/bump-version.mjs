/**
 * Write a version into the published package's manifest.
 *
 * This is semantic-release's `prepare` step, and it exists instead of
 * `npm version` because npm would reach for a lockfile it does not own: this
 * workspace is resolved by bun, and `npm version` inside a member wants to
 * reconcile `package-lock.json` before it will touch the manifest.
 *
 * The version is validated rather than trusted. The caller is a template
 * expansion (`${nextRelease.version}`), and the failure mode of an empty or
 * malformed expansion is a manifest that packs and publishes under a version
 * nobody can undo.
 *
 * Usage: node scripts/bump-version.mjs <version>
 */

import { readFile, writeFile } from 'node:fs/promises'
import { argv, exit } from 'node:process'

const version = argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: node scripts/bump-version.mjs <version>, got ${JSON.stringify(version)}`)
  exit(2)
}

const manifest = new URL('../packages/web-login/package.json', import.meta.url)
const pkg = JSON.parse(await readFile(manifest, 'utf8'))
pkg.version = version

// Re-serialized rather than patched by regex: key order survives a round trip
// through JSON, and the result is what Biome's formatter would have written.
await writeFile(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`${pkg.name} is now ${version}`)
