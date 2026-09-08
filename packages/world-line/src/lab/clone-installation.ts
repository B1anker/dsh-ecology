import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import type { CliContext } from '../context.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { cloneTree } from '../fs/clone.js'
import { requirePnpm } from './gate.js'
import type { LabManifest } from './manifest.js'
import { runCaptured } from './runner.js'
import { labStorePolicy } from './store.js'
/** Opportunistic private installation seed. Local/external links fall back to a fresh install. */
export async function seedInstallation(
  ctx: CliContext,
  source: string,
  target: string,
  manifest: LabManifest,
  hasLocal: boolean,
) {
  if (hasLocal) return { seeded: false, reason: 'local-dependencies' }
  const from = join(source, 'node_modules'),
    to = join(target, 'node_modules')
  const info = await lstat(from).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink())
    return { seeded: false, reason: 'no-installation' }
  try {
    const text = await readFile(join(from, '.modules.yaml'), 'utf8'),
      metadata = load(text, { schema: JSON_SCHEMA }) as Record<string, unknown>
    if (!metadata || typeof metadata.storeDir !== 'string')
      return { seeded: false, reason: 'unknown-metadata' }
    const store = labStorePolicy(ctx.home, manifest),
      env = store.environment(ctx.experimentEnv ?? ctx.env)
    const result = await runCaptured(
      requirePnpm(ctx.env).path,
      ['store', 'path', ...store.flags.slice(0, 2)],
      { cwd: target, env, timeoutMs: 15000 },
    )
    if (result.exitCode !== 0 || !result.stdout.trim().startsWith(store.directory))
      return { seeded: false, reason: 'store-unavailable' }
    const clone = await cloneTree(from, to)
    metadata.storeDir = result.stdout.trim()
    metadata.virtualStoreDir = join(to, '.pnpm')
    await writeFileAtomic(join(to, '.modules.yaml'), dump(metadata, { schema: JSON_SCHEMA }))
    return { seeded: true, ...clone }
  } catch {
    await rm(to, { recursive: true, force: true })
    return { seeded: false, reason: 'fresh-install-required' }
  }
}
