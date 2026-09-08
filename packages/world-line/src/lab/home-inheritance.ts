import { chmod, lstat, mkdir, readdir, readFile, readlink, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import { FileError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { cloneFile } from '../fs/clone.js'
import { inheritModelConfiguration } from './model-config.js'

const inspect = async (path: string) =>
  lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })

const EXCLUDED = new Set([
  'world-line',
  'node_modules',
  '.git',
  '.cache',
  'cache',
  'caches',
  'logs',
  'tmp',
  'temp',
  'run',
  '.env',
  '.credentials.yaml',
  'settings.yaml',
])
function excluded(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  if (parts.some((part) => part.startsWith('.wl-'))) return true
  if (parts.some((part) => EXCLUDED.has(part))) return true
  // Conversation history under home/sessions is persistent data, unlike auth sessions.
  if (parts[0] === 'auth' && /^(sessions?|recovery|invitations?|oauth-state)([.\-_]|$)/i.test(name))
    return true
  if (/\.(pid|sock|socket|lock)$|\.tmp(?:-|$)|^Singleton/.test(name)) return true
  return parts[0] === 'profiles' && name === 'cordis.yml'
}

/** Rewrite structured configuration paths, never arbitrary history or binary data. */
export function rebaseHomePaths(value: unknown, source: string, target: string): unknown {
  if (typeof value === 'string') {
    if (value === target || value.startsWith(`${target}/`)) return value
    if (value === source || value.startsWith(`${source}/`))
      return target + value.slice(source.length)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => rebaseHomePaths(item, source, target))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rebaseHomePaths(item, source, target)]),
    )
  return value
}

/** One-time independent copy. Existing files win; never follow target symlinks. */
export async function inheritHome(
  sourceHome: string,
  targetHome: string,
  options: { apiKeys?: boolean; skipPaths?: string[] } = {},
): Promise<{ copied: number; skippedLinks: string[] }> {
  const source = resolve(sourceHome)
  const target = resolve(targetHome)
  if (source === target) throw new FileError('cannot inherit a home into itself')
  const result = { copied: 0, skippedLinks: [] as string[] }
  const root = await inspect(target)
  if (root && (!root.isDirectory() || root.isSymbolicLink()))
    throw new FileError('mirror home must be a real directory')
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  const visit = async (path: string): Promise<void> => {
    if (
      excluded(path) ||
      options.skipPaths?.some((skip) => path === skip || path.startsWith(`${skip}/`))
    )
      return
    const from = join(source, path)
    const to = join(target, path)
    const info = await lstat(from)
    const existing = await inspect(to)
    if (existing?.isSymbolicLink()) {
      if (info.isSymbolicLink()) {
        const mapped = relative(source, resolve(dirname(from), await readlink(from)))
        if (
          mapped &&
          !mapped.startsWith('../') &&
          !excluded(mapped) &&
          resolve(dirname(to), await readlink(to)) === join(target, mapped)
        )
          return
      }
      throw new FileError(`cannot inherit through mirror symlink: ${path}`)
    }
    if (info.isDirectory()) {
      if (existing && !existing.isDirectory()) return
      await mkdir(to, { recursive: true, mode: 0o700 })
      await chmod(to, 0o700)
      for (const name of await readdir(from)) await visit(`${path}/${name}`)
      return
    }
    if (existing) return
    if (info.isSymbolicLink()) {
      const destination = resolve(dirname(from), await readlink(from))
      const mapped = relative(source, destination)
      // External links must not remain writable aliases into the official environment.
      if (!mapped || mapped.startsWith('../') || excluded(mapped)) {
        result.skippedLinks.push(path)
        return
      }
      await symlink(relative(dirname(to), join(target, mapped)), to)
      result.copied++
      return
    }
    if (!info.isFile()) return // sockets, FIFOs and devices are runtime state
    if (!/^(?:profiles\/[^/]+\/)?cordis\.patch\.ya?ml$/.test(path)) {
      await cloneFile(from, to, info.mode & 0o100 ? 0o700 : 0o600)
      result.copied++
      return
    }
    let bytes: Uint8Array | string = await readFile(from)
    if (/^(?:profiles\/[^/]+\/)?cordis\.patch\.ya?ml$/.test(path)) {
      try {
        bytes = dump(rebaseHomePaths(load(Buffer.from(bytes).toString('utf8')), source, target))
      } catch {
        throw new FileError(`cannot parse inherited configuration: ${path}`)
      }
    }
    await writeFileAtomic(to, bytes, { mode: info.mode & 0o100 ? 0o700 : 0o600 })
    result.copied++
  }
  for (const name of await readdir(source)) await visit(name)
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    if (
      (await inspect(join(source, name)))?.isSymbolicLink() ||
      (await inspect(join(target, name)))?.isSymbolicLink()
    )
      throw new FileError(`cannot inherit linked ${name}`)
  }
  await inheritModelConfiguration(source, target, { ...options, allSettings: true })
  return result
}
