import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { acquireLock } from '../fs/lock.js'
import { LAB_ID_RE, labRoot, listLabs } from './layout.js'
import { readLabManifest, writeLabManifest } from './manifest.js'

export async function resolveLabId(home: string, reference: string): Promise<string> {
  if (LAB_ID_RE.test(reference)) return reference
  for (const id of await listLabs(home)) {
    const manifest = await readLabManifest(home, id)
    if (manifest.alias === reference) return id
  }
  throw new UsageError(`unknown lab id or alias ${JSON.stringify(reference)}`)
}

/** Aliases live with their lab, so destroying a lab releases its name. */
export async function runLabAlias(
  ctx: CliContext,
  reference: string,
  alias: string,
): Promise<{ id: string; alias: string }> {
  await assertAliasAvailable(ctx.home, alias, await resolveLabId(ctx.home, reference))
  const lock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'lab alias',
    breakStale: ctx.breakStaleLock,
  })
  try {
    const id = await resolveLabId(ctx.home, reference)
    const manifest = await readLabManifest(ctx.home, id)
    if (manifest.state === 'applying')
      throw new UsageError('cannot rename a lab while it is applying')
    for (const otherId of await listLabs(ctx.home)) {
      if (otherId === id) continue
      if ((await readLabManifest(ctx.home, otherId)).alias === alias)
        throw new UsageError(`alias ${alias} is already assigned to ${otherId}`)
    }
    await writeLabManifest(ctx.home, { ...manifest, alias }, ctx.now())
    return { id, alias }
  } finally {
    await lock.release()
  }
}

/** Caller must hold the service lock while allocating a name. */
export async function assertAliasAvailable(
  home: string,
  alias: string,
  except?: string,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(alias) || alias.startsWith('lab-')) {
    throw new UsageError(
      'alias must be 1-64 letters, digits, underscores or hyphens, start with a letter or digit, and not start with lab-',
    )
  }
  for (const id of await listLabs(home)) {
    if (id !== except && (await readLabManifest(home, id)).alias === alias)
      throw new UsageError(`alias ${alias} is already assigned`)
  }
}
