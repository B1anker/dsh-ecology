/**
 * Local dependency bridging for cloned labs (bugfix): the whitelist copy is
 * deliberately verbatim — receipts and lockfileHash stay meaningful — but
 * relative `file:`/`link:` specifiers, and pnpm's normalized relative
 * lockfile entries (`specifier:`/`version:`/`resolution.directory`), resolve
 * against the lab's deeper profile directory and would ENOENT on the first
 * `dsh plugin add`. After the copy, each relative target is recreated
 * *inside the lab* as a directory symlink to the real source directory, so
 * pnpm resolves it exactly as it did in the source profile.
 *
 * Best effort by design: missing targets are reported and skipped (install
 * then fails with the same clear error as without bridging), existing paths
 * are never overwritten, targets that resolve inside the lab profile are
 * left alone, and targets that would climb out of the lab dir entirely are
 * refused (labs never write outside their own dir — see layout.ts). Lab
 * cleanup is safe: `fs.rm recursive` unlinks these symlinks instead of
 * following them.
 */

import { lstat, mkdir, readFile, stat, symlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

export interface LocalDepsSummary {
  /** Relative paths (as written) that got a working symlink. */
  linked: string[]
  /** Relative paths whose real target does not exist (skipped). */
  missing: string[]
}

/** Relative `file:`/`link:` targets declared in one package.json text. */
export function packageJsonLocalDeps(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const targets: string[] = []
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = (parsed as Record<string, unknown>)[key]
    if (typeof deps !== 'object' || deps === null) continue
    for (const value of Object.values(deps as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      const match = /^(?:file|link):(.+)$/.exec(value)
      if (match?.[1] !== undefined && match[1].startsWith('.')) targets.push(match[1])
    }
  }
  return targets
}

/**
 * Relative `file:`/`link:` targets and `resolution.directory` entries in one
 * pnpm-lock.yaml text. Scanned as text: pnpm writes these unquoted, and the
 * `packages:` keys would make a YAML walk clumsier than the two patterns.
 */
export function lockfileLocalDeps(text: string): string[] {
  const targets: string[] = []
  for (const match of text.matchAll(/(?:file|link):(\.{1,2}\/[^\s'":]+)/g)) {
    if (match[1] !== undefined) targets.push(match[1])
  }
  for (const match of text.matchAll(/^\s*directory:\s*(\.{1,2}\/[^\s'"]+)\s*$/gm)) {
    if (match[1] !== undefined) targets.push(match[1])
  }
  return targets
}

/**
 * Bridge the relative local dependencies of the copied composition files in
 * `labProfileDir`: for each unique relative target, symlink
 * `resolve(labProfileDir, rel)` → `resolve(sourceProfileDir, rel)`. Only
 * links that climb out of the lab profile yet stay inside the lab dir are
 * created; anything else already lives inside the clone (or would escape the
 * lab) and is left alone.
 */
export async function linkLocalDeps(
  sourceProfileDir: string,
  labProfileDir: string,
): Promise<LocalDepsSummary> {
  const rels = new Set<string>()
  const manifest = await readFile(join(labProfileDir, 'package.json'), 'utf8').catch(() => null)
  if (manifest !== null) {
    for (const rel of packageJsonLocalDeps(manifest)) rels.add(rel)
  }
  const lockfile = await readFile(join(labProfileDir, 'pnpm-lock.yaml'), 'utf8').catch(() => null)
  if (lockfile !== null) {
    for (const rel of lockfileLocalDeps(lockfile)) rels.add(rel)
  }

  const linked: string[] = []
  const missing: string[] = []
  const labRoot = resolve(labProfileDir)
  // Lab profile dirs have the fixed shape <lab>/home/profiles/<name>.
  const labDir = resolve(labProfileDir, '..', '..', '..')
  for (const rel of [...rels].toSorted()) {
    const target = resolve(sourceProfileDir, rel)
    const link = resolve(labProfileDir, rel)
    if (link === labRoot || link.startsWith(labRoot + sep)) continue
    if (link !== labDir && !link.startsWith(labDir + sep)) continue
    try {
      await stat(target)
    } catch {
      missing.push(rel)
      continue
    }
    if ((await lstat(link).catch(() => null)) !== null) continue
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link, 'dir')
    linked.push(rel)
  }
  return { linked, missing }
}
