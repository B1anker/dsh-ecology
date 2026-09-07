import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { FileError, UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { acquireLock } from '../fs/lock.js'
import { resolveLabId } from './aliases.js'
import { LAB_ID_RE, labRoot } from './layout.js'
import { readLabManifest } from './manifest.js'

async function readDefaults(home: string): Promise<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(await readFile(join(labRoot(home), '.defaults.json'), 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((id) => typeof id !== 'string' || !LAB_ID_RE.test(id))
    )
      throw new Error('invalid defaults')
    return value as Record<string, string>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new FileError('cannot read lab defaults')
  }
}

export async function defaultLabId(home: string, profile: string): Promise<string | undefined> {
  const defaults = await readDefaults(home)
  return Object.hasOwn(defaults, profile) ? defaults[profile] : undefined
}

/** Caller holds the lab service lock. */
export async function removeLabDefault(home: string, id: string): Promise<void> {
  const defaults = await readDefaults(home)
  if (!Object.values(defaults).includes(id)) return
  await writeFileAtomic(
    join(labRoot(home), '.defaults.json'),
    JSON.stringify(
      Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== id)),
    ),
  )
}

export async function runLabDefault(
  ctx: CliContext,
  reference?: string,
  clear = false,
): Promise<{ profile: string; id: string | null; alias: string | null }> {
  if (reference && clear) throw new UsageError('lab default cannot combine an id with --clear')
  const lock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'lab default',
    breakStale: ctx.breakStaleLock,
  })
  try {
    const defaults = await readDefaults(ctx.home)
    if (clear) {
      delete defaults[ctx.profileName]
      await writeFileAtomic(join(labRoot(ctx.home), '.defaults.json'), JSON.stringify(defaults))
      return { profile: ctx.profileName, id: null, alias: null }
    }
    const id = reference
      ? await resolveLabId(ctx.home, reference)
      : await defaultLabId(ctx.home, ctx.profileName)
    if (!id) return { profile: ctx.profileName, id: null, alias: null }
    const manifest = await readLabManifest(ctx.home, id)
    if (manifest.purpose !== 'mirror' || manifest.source.profileName !== ctx.profileName)
      throw new UsageError('default lab must be a mirror of the selected profile')
    if (reference)
      await writeFileAtomic(
        join(labRoot(ctx.home), '.defaults.json'),
        JSON.stringify({ ...defaults, [ctx.profileName]: id }),
      )
    return { profile: ctx.profileName, id, alias: manifest.alias ?? null }
  } finally {
    await lock.release()
  }
}
