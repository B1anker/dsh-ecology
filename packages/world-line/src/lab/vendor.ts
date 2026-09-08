import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { classifySpec } from '../domain/composition.js'
import { UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { cloneFile, cloneTree } from '../fs/clone.js'
import { sha256Hex } from '../fs/hash.js'
import { localSourceHash } from './local-source.js'
export interface LocalMapping {
  name: string
  target: string
  spec: string
}
/** Rewrite only local locators, keeping remote resolutions and integrity records intact. */
export function rewriteLocalLock(value: unknown, base: string, mappings: LocalMapping[]): unknown {
  const text = (value: string): string => {
    for (const m of mappings) {
      const marker = value.includes('@file:')
        ? '@file:'
        : value.includes('@link:')
          ? '@link:'
          : null
      const prefix = marker ? value.slice(0, value.indexOf(marker) + 1) : ''
      const rest = marker ? value.slice(prefix.length) : value
      if (/^(file:|link:)/.test(rest)) {
        const suffix = rest.indexOf('('),
          path = suffix < 0 ? rest.slice(5) : rest.slice(5, suffix)
        if (resolve(base, path) === resolve(m.target))
          return prefix + m.spec + (suffix < 0 ? '' : rest.slice(suffix))
      } else if (
        (value.startsWith('.') || value.startsWith('/')) &&
        resolve(base, value) === resolve(m.target)
      )
        return m.spec.slice(5)
    }
    return value
  }
  if (typeof value === 'string') return text(value)
  if (Array.isArray(value)) return value.map((v) => rewriteLocalLock(v, base, mappings))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [text(k), rewriteLocalLock(v, base, mappings)]),
    )
  return value
}
export async function freezeLocalProfile(
  profile: string,
  sourceProfile: string,
  artifactRoot: string,
) {
  const path = join(profile, 'package.json'),
    pkg = JSON.parse(await readFile(path, 'utf8')),
    mappings: LocalMapping[] = []
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec !== 'string') throw new UsageError('Invalid dependency declaration')
      const classified = classifySpec(spec, sourceProfile)
      if (!['file', 'link'].includes(classified.kind) || !classified.target) continue
      const target = classified.target,
        info = await lstat(target),
        dest = join(artifactRoot, sha256Hex(name).slice(0, 16))
      const existing = mappings.find((m) => m.name === name)
      if (existing) {
        pkg[field][name] = existing.spec
        continue
      }
      if (info.isDirectory()) {
        const before = await localSourceHash(target)
        await cloneTree(target, dest, new Set(['node_modules', '.git', '.env']))
        if (before !== (await localSourceHash(target)))
          throw new UsageError('Local source changed while freezing deployment')
      } else if (info.isFile()) {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
        await cloneFile(target, dest)
      } else throw new UsageError('Unsafe local dependency')
      const next = { name, target, spec: `file:${dest}` }
      mappings.push(next)
      pkg[field][name] = next.spec
    }
  if (mappings.length) {
    await writeFileAtomic(path, JSON.stringify(pkg, null, 2))
    const lock = join(profile, 'pnpm-lock.yaml'),
      text = await readFile(lock, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return null
        throw e
      })
    if (text !== null)
      await writeFileAtomic(
        lock,
        dump(rewriteLocalLock(load(text, { schema: JSON_SCHEMA }), sourceProfile, mappings), {
          schema: JSON_SCHEMA,
        }),
      )
  }
}
