import { basename, dirname, resolve } from 'node:path'
import { UsageError } from '../domain/errors.js'
import { LAB_ID_RE, labHomeDir } from './layout.js'
/** Recover identity even if a user launches dsh directly in a managed child home. */
export function currentLabId(runtimeHome: string, hint?: string): string | undefined {
  if (hint) return hint
  const home = resolve(runtimeHome),
    parent = dirname(home)
  return basename(home) === 'home' &&
    basename(dirname(parent)) === 'labs' &&
    basename(dirname(dirname(parent))) === 'world-line' &&
    LAB_ID_RE.test(basename(parent))
    ? basename(parent)
    : undefined
}
/** Children share the original registry; a missing hint must never create a registry inside a child. */
export function managerHome(runtimeHome: string, labId?: string, hint?: string): string {
  const home = resolve(runtimeHome)
  const id = currentLabId(home, labId)
  if (!id) return resolve(hint ?? home)
  const manager = resolve(hint ?? resolve(home, '../../../..'))
  if (labHomeDir(manager, id) !== home)
    throw new UsageError('世界线管理目录与当前实例不匹配，请通过 wl lab start 启动')
  return manager
}
