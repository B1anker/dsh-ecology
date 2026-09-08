import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { labHomeDir } from './layout.js'
import { readLabManifest } from './manifest.js'

/** Resolve only a retained interactive source; never fall back to the main profile. */
export async function sourceContext(ctx: CliContext, parentLabId?: string): Promise<CliContext> {
  if (!parentLabId || parentLabId === 'origin') return ctx
  const parent = await readLabManifest(ctx.home, parentLabId)
  if (parent.source.profileName !== ctx.profileName || parent.purpose !== 'mirror')
    throw new UsageError('验证来源必须是当前环境的普通世界线')
  if (parent.state === 'applying' || parent.state === 'destroyed')
    throw new UsageError('来源世界线正在准备或已删除，暂时不能验证或合入')
  return { ...ctx, home: labHomeDir(ctx.home, parentLabId) }
}
