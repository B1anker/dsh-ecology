/**
 * Profile composition semantics: the patch-file YAML dialect, the profile
 * manifest (`package.json` + `dsh.profile`), and dependency-spec
 * classification.
 *
 * The dialect mirrors the host's own parser (verified against
 * `@deepseek-ai/dsh-app-boot` 0.1.2-rc.1, vendor/include/src/index.ts): a
 * top-level YAML array of loader patch entries over the JSON schema extended
 * with the `!!js` scalar tag, which round-trips as unevaluated expression
 * nodes — the loader evaluates them at entry activation, this tool never
 * does. Parsing with the same schema means a file DSH can read is a file we
 * can summarise, and a file we reject is one DSH would fail loud on too.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import yaml from 'js-yaml'

import { FileError } from './errors.js'
import { detectSecretShapes, redactText, redactTree } from './redaction.js'

/** An unevaluated `!!js` expression node, exactly as the host represents it. */
export interface JsExpressionNode {
  __jsExpr: string
}

/** js-yaml scalar type for `!!js` expressions (never evaluated here). */
const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): JsExpressionNode => ({ __jsExpr: String(data) }),
  predicate: (data: unknown): data is JsExpressionNode =>
    typeof data === 'object' && data !== null && '__jsExpr' in data,
  represent: (data: unknown): unknown =>
    typeof data === 'object' && data !== null && '__jsExpr' in data
      ? String((data as JsExpressionNode).__jsExpr)
      : data,
})

/** The entry-list YAML dialect shared with the host's loader. */
export const patchSchema = yaml.JSON_SCHEMA.extend(JsExprType)

/** Parse patch-list text; throws {@link FileError} with the host's own failure modes. */
export function parsePatchListText(text: string, source: string): unknown[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text, { schema: patchSchema })
  } catch (error) {
    throw new FileError(`failed to parse patches ${source}: ${redactText(String(error))}`)
  }
  if (!Array.isArray(parsed)) {
    throw new FileError(`patches ${source} must be a top-level YAML array of loader patch entries`)
  }
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FileError(
        `patches entry ${index + 1} in ${source} must be a mapping (a loader patch entry)`,
      )
    }
  })
  return parsed
}

/** Read and parse an optional patch-list file; `null` when it does not exist. */
export async function parsePatchFile(file: string): Promise<unknown[] | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new FileError(`failed to read patches ${file}`)
  }
  return parsePatchListText(text, file)
}

/** What one patch entry contributes, for manifests and diffs. */
export interface PatchEntrySummary {
  /** 1-based position in its file. */
  index: number
  /** The targeted row id; absent when the entry only carries `name`/`group`. */
  id?: string
  /** `disabled: true` marks the row for removal at compose time. */
  disabled: boolean
  /** Redacted config tree (structure kept, secret values masked). */
  config: unknown
  /** Names an `insert` list would add, in order. */
  insertNames: string[]
}

/**
 * Summarise one parsed patch list into manifest/diff-safe entries: ids,
 * disabled flags, redacted config trees, and insert names. Entries are
 * reported 1-based and never evaluated.
 */
export function summarizePatchEntries(parsed: unknown[]): PatchEntrySummary[] {
  return parsed.map((raw, index) => {
    const entry = raw as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : undefined
    const config = entry.config
    const insert = Array.isArray(entry.insert) ? entry.insert : []
    const insertNames = insert.flatMap((row) => {
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
        const name = (row as Record<string, unknown>).name
        return typeof name === 'string' ? [name] : []
      }
      return []
    })
    return {
      index: index + 1,
      id,
      disabled: entry.disabled === true,
      config: config === undefined ? null : redactTree(config),
      insertNames,
    }
  })
}

/** Detect secret shapes inside a patch/config file's text (skip policy input). */
export function scanFileText(text: string): string[] {
  return detectSecretShapes(text)
}

/** A parsed profile manifest (`package.json` of the profile). */
export interface ProfileManifest {
  /** Raw parsed object. */
  raw: Record<string, unknown>
  name: string | undefined
  dependencies: Record<string, string>
  /** Ordered `dsh.profile.bundles` layer list (may be absent pre-init). */
  bundles: string[]
  patchReload: string | undefined
}

/** Parse a profile manifest from JSON text; throws {@link FileError}. */
export function parseProfileManifest(text: string, source: string): ProfileManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new FileError(
      `profile manifest ${source} is not valid JSON: ${redactText(String(error))}`,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FileError(`profile manifest ${source} must hold a JSON object`)
  }
  const record = raw as Record<string, unknown>
  const dsh = (record.dsh ?? {}) as Record<string, unknown>
  const profileSection = (dsh.profile ?? {}) as Record<string, unknown>
  const dependencies = record.dependencies
  return {
    raw: record,
    name: typeof record.name === 'string' ? record.name : undefined,
    dependencies:
      dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
        ? (dependencies as Record<string, string>)
        : {},
    bundles: Array.isArray(profileSection.bundles)
      ? profileSection.bundles.filter((value): value is string => typeof value === 'string')
      : [],
    patchReload:
      typeof profileSection.patchReload === 'string' ? profileSection.patchReload : undefined,
  }
}

/** One dependency's spec kind, mirroring what pnpm/dsh can write. */
export type DependencyKind = 'registry' | 'link' | 'file' | 'git' | 'tarball' | 'unknown'

export interface ClassifiedSpec {
  kind: DependencyKind
  /** The spec exactly as recorded in `dependencies`. */
  spec: string
  /** For link:/file: specs, the target path resolved against the profile dir. */
  target?: string
  /** For registry specs, the package name portion before `@range`. */
  packageName?: string
}

/** Classify one dependency spec string. */
export function classifySpec(spec: string, profileDir: string): ClassifiedSpec {
  const linkMatch = /^link:(.+)$/.exec(spec)
  if (linkMatch?.[1] !== undefined) {
    return { kind: 'link', spec, target: resolveSpecTarget(linkMatch[1], profileDir) }
  }
  const fileMatch = /^file:(.+)$/.exec(spec)
  if (fileMatch?.[1] !== undefined) {
    return { kind: 'file', spec, target: resolveSpecTarget(fileMatch[1], profileDir) }
  }
  if (/^(?:git\+|github:|git:|https?:.*\.git(?:#|$))/.test(spec)) {
    return { kind: 'git', spec }
  }
  if (/\.(?:tgz|tar\.gz)(?:#|$)/.test(spec) || /^https?:\/\//.test(spec)) {
    return { kind: 'tarball', spec }
  }
  // Registry specs are dense: a name with an optional `@range`. Whitespace or
  // a leading `=` means something else entirely (`=== weird ===` is not a
  // dependency).
  if (/\s/.test(spec) || spec.startsWith('=')) {
    return { kind: 'unknown', spec }
  }
  const registryName = spec.startsWith('@') ? scopedPackageName(spec) : barePackageName(spec)
  if (registryName !== undefined && registryName !== '') {
    return { kind: 'registry', spec, packageName: registryName }
  }
  return { kind: 'unknown', spec }
}

/** `@scope/name@range` → `@scope/name`. */
function scopedPackageName(spec: string): string | undefined {
  const secondAt = spec.indexOf('@', 1)
  const namePart = spec.slice(1, secondAt === -1 ? undefined : secondAt)
  if (namePart === '' || !namePart.includes('/')) return undefined
  return `@${namePart}`
}

/** `name@range` → `name` (range-less specs return the whole name). */
function barePackageName(spec: string): string | undefined {
  const name = spec.split('@')[0]
  return name === '' ? undefined : name
}

/** Resolve a link/file target: absolute stays, relative resolves against the profile dir. */
function resolveSpecTarget(target: string, profileDir: string): string {
  if (target === '') return profileDir
  return isAbsolute(target) ? target : resolve(profileDir, target)
}
