#!/usr/bin/env node
/**
 * Syntax gate for CI, standing in for a full linter.
 *
 * The package ships plain ESM with JSDoc and no build step, so the failure this
 * needs to catch is a file that cannot be parsed. Two extra checks earn their
 * place because both have bitten this codebase: a raw control byte in source
 * (invisible in review, breaks editors and diff tools) and a literal that looks
 * like a committed scrypt verifier.
 *
 * Parsing runs as `node --check` in a child process rather than a dynamic
 * import. Importing would *execute* — and one of the files in this package is a
 * CLI that prompts on a TTY, so an import-based checker either hangs or reports
 * a false failure.
 */

import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { execPath, exit, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage'])
const VERIFIER = /scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}/

/**
 * Recursively list JavaScript sources.
 * @param dir - directory to walk.
 * @returns absolute paths of `.js`/`.mjs` files.
 */
async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      out.push(...await collect(join(dir, entry.name)))
      continue
    }
    if (/\.m?js$/.test(entry.name)) out.push(join(dir, entry.name))
  }
  return out
}

const files = (await collect(ROOT)).sort()
const failures = []

for (const file of files) {
  const shown = relative(ROOT, file)
  const source = await readFile(file, 'utf8')

  for (const [index, line] of source.split('\n').entries()) {
    for (const character of line) {
      const code = character.codePointAt(0)
      if ((code < 32 && code !== 9) || code === 127) {
        failures.push(
          `${shown}:${index + 1}: raw control byte U+${code.toString(16).padStart(4, '0')}`,
        )
        break
      }
    }
  }

  if (VERIFIER.test(source)) {
    failures.push(`${shown}: looks like a committed scrypt verifier`)
  }

  try {
    await run(execPath, ['--check', file])
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split('\n').find(
      (line) => line.includes('Error') || line.includes('error'),
    )
    failures.push(`${shown}: ${detail ?? 'failed to parse'}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) stdout.write(`FAIL ${failure}\n`)
  exit(1)
}

stdout.write(`ok: ${files.length} file(s) parsed\n`)
