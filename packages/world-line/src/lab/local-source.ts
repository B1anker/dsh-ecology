import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VerificationError } from '../domain/errors.js'

/** Match the isolated-copy set. Links fail closed instead of hashing their mutable targets. */
export async function localSourceHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  let count = 0,
    bytes = 0
  const visit = async (relative: string): Promise<void> => {
    const path = join(root, relative)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new VerificationError('本地插件包含符号链接，无法固定源码状态')
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).toSorted()) {
        if (!['node_modules', '.git', '.env'].includes(name))
          await visit(relative ? `${relative}/${name}` : name)
      }
    } else if (stat.isFile()) {
      count++
      bytes += stat.size
      if (count > 20000 || bytes > 128 * 1024 * 1024)
        throw new VerificationError('本地插件过大，无法固定源码状态')
      hash.update(`${relative}\0${stat.mode & 0o111}\0${stat.size}\0`)
      hash.update(await readFile(path))
    } else throw new VerificationError('本地插件包含非普通文件')
  }
  await visit('')
  return hash.digest('hex')
}
