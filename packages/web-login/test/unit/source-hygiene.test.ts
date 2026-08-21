/**
 * Two properties of the source tree itself.
 *
 * These come from `scripts/check-syntax.mjs`, which the TypeScript migration
 * retired: its main job was `node --check` on every `.js` file, and `tsc` covers
 * parsing far better than that ever did. But it carried two scans that no type
 * checker, oxlint, or biome rule replaces, and its own header records that both
 * "have bitten this codebase". They live here because a test is the one place
 * that already runs in CI, on every change, with a message attached.
 *
 * Written as tests over the tree rather than a script so a failure names the
 * file and line and says why it matters.
 *
 * @module test/unit/source-hygiene
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@rstest/core'

/** The package root, resolved from this file so the cwd cannot change it. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Directories with no source of ours in them. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist'])

/** A scrypt verifier as `hashPassword` emits it: `scrypt$<32 hex>$<128 hex>`. */
const VERIFIER = /scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}/

/**
 * Every file worth scanning, relative to the package root.
 *
 * Covers TypeScript, JSON, and Markdown: a verifier pasted into a README or an
 * example config is committed just as thoroughly as one in a module.
 *
 * @param dir - directory to walk.
 * @returns package-relative paths, sorted.
 */
async function collect(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      out.push(...(await collect(full)))
      continue
    }
    if (/\.(m?ts|m?js|json|md)$/.test(entry.name)) out.push(relative(ROOT, full))
  }
  return out.toSorted()
}

test('no source file contains a raw control byte', async () => {
  // A control byte is invisible in review and in most diffs, and it breaks
  // editors and tooling downstream of it. Tab and the newlines that `split`
  // consumes are the only ones with a legitimate reason to be here; anything
  // else belongs in source as an escape ('\u005cu0003'), which is plain
  // text and reviewable as such.
  const offenders: string[] = []
  for (const file of await collect(ROOT)) {
    const source = await readFile(join(ROOT, file), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      for (const character of line) {
        const code = character.codePointAt(0) ?? 0
        if ((code < 32 && code !== 9) || code === 127) {
          const point = code.toString(16).padStart(4, '0')
          offenders.push(`${file}:${index + 1}: raw control byte U+${point}`)
          break
        }
      }
    }
  }
  expect(offenders, 'control bytes must be written as escapes, not embedded').toEqual([])
})

test('no source file contains a scrypt verifier', async () => {
  // A verifier in the tree is a credential in the tree: it survives in history
  // after any later deletion, and every clone gets a copy. The test fixtures
  // derive theirs at run time from a throwaway password for exactly this reason,
  // so a match here is a real leak rather than a fixture.
  const offenders: string[] = []
  for (const file of await collect(ROOT)) {
    const source = await readFile(join(ROOT, file), 'utf8')
    // The verifier is deliberately not included in the failure message: this
    // output ends up in CI logs, which are the sort of place a leaked
    // credential goes on to be read from.
    if (VERIFIER.test(source)) offenders.push(`${file}: looks like a committed scrypt verifier`)
  }
  expect(offenders, 'a verifier must never be committed; rotate it if this fires').toEqual([])
})
