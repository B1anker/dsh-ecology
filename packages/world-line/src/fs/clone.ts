import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { UsageError } from '../domain/errors.js'

/** Reflink if supported, otherwise copy. Never create writable hard links. */
export async function cloneFile(source: string, target: string, mode = 0o600) {
  await copyFile(source, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
  await chmod(target, mode)
}
export async function cloneTree(
  source: string,
  target: string,
  exclude: ReadonlySet<string> = new Set(),
  skipExternalLinks = false,
) {
  const base = resolve(source)
  let files = 0
  const visit = async (path: string) => {
    const from = join(base, path),
      to = join(target, path),
      info = await lstat(from)
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 })
      for (const name of await readdir(from)) {
        if (!exclude.has(name)) await visit(path ? `${path}/${name}` : name)
      }
    } else if (info.isFile()) {
      await cloneFile(from, to, info.mode & 0o111 ? 0o700 : 0o600)
      files++
    } else if (info.isSymbolicLink()) {
      const link = resolve(dirname(from), await readlink(from)),
        mapped = relative(base, link)
      if ((mapped.startsWith('..') || !mapped) && skipExternalLinks) return
      if (mapped.startsWith('..') || !mapped)
        throw new UsageError('复制目录含外部符号链接，请先固定本地插件源码')
      await symlink(relative(dirname(to), join(target, mapped)), to)
    } else throw new UsageError('复制目录含设备或运行时文件')
  }
  await visit('')
  return { files, method: 'clone-or-copy' }
}
