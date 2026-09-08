import { constants } from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from '../domain/errors.js'
import { sha256Hex } from '../fs/hash.js'
import { labDir, labLogDir } from './layout.js'

export const artifactIdPattern = /^probe-(?:[0-9]+-)?[A-Za-z0-9]+$/
async function checkedDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new UsageError('工件目录不可信')
}
export async function artifactRoot(home: string, id: string) {
  for (const path of [
    join(home, 'world-line'),
    join(home, 'world-line', 'labs'),
    labDir(home, id),
    labLogDir(home, id),
  ])
    await checkedDirectory(path)
  const root = join(labLogDir(home, id), 'browser-artifacts')
  await checkedDirectory(root)
  return root
}
export async function artifactInventory(root: string) {
  await checkedDirectory(root)
  const rows: {
    id: string
    createdAt: string
    environment: string
    files: { name: string; bytes: number }[]
  }[] = []
  for (const id of await readdir(root)) {
    if (!artifactIdPattern.test(id)) continue
    try {
      const dir = join(root, id)
      await checkedDirectory(dir)
      const handle = await open(join(dir, 'index.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let index: any
      try {
        if ((await handle.stat()).size > 8192) continue
        index = JSON.parse(await handle.readFile('utf8'))
      } finally {
        await handle.close()
      }
      if (
        index.version !== 1 ||
        index.private !== true ||
        !Array.isArray(index.files) ||
        !Number.isFinite(Date.parse(index.createdAt))
      )
        continue
      const files = []
      for (const name of index.files) {
        if (name !== 'trace.zip' && name !== 'failure.png') continue
        const info = await lstat(join(dir, name))
        if (info.isFile() && !info.isSymbolicLink()) files.push({ name, bytes: info.size })
      }
      rows.push({
        id,
        createdAt: index.createdAt,
        environment: index.context === 'promotion-restart' ? '来源环境重启验证' : '实验环境验证',
        files,
      })
    } catch {
      /* A partial or corrupt capture cannot hide other completed captures. */
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}
export async function readArtifact(home: string, labId: string, id: string, name: string) {
  if (!artifactIdPattern.test(id) || !['trace.zip', 'failure.png'].includes(name))
    throw new UsageError('无效工件')
  const root = await artifactRoot(home, labId)
  if (
    !(await artifactInventory(root)).some(
      (row) => row.id === id && row.files.some((f) => f.name === name),
    )
  )
    throw new UsageError('工件不存在')
  await checkedDirectory(join(root, id))
  const handle = await open(join(root, id, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 128 * 1024 * 1024)
      throw new UsageError('工件超过 128 MiB，请在本机访问')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
export async function artifactCleanup(
  root: string,
  apply = false,
  revision?: string,
  now = Date.now(),
) {
  const rows = await artifactInventory(root)
  // Keep the newest result even if old, so the latest diagnosis stays inspectable.
  const candidates = rows.filter(
    (row, i) => i > 0 && (i >= 30 || now - Date.parse(row.createdAt) > 7 * 86400000),
  )
  const current = sha256Hex(JSON.stringify(rows))
  if (apply && revision !== current) throw new UsageError('工件已变化，请重新预览')
  if (apply) for (const row of candidates) await rm(join(root, row.id), { recursive: true })
  return {
    revision: current,
    candidates,
    bytes: candidates.reduce((n, row) => n + row.files.reduce((s, f) => s + f.bytes, 0), 0),
    applied: apply,
  }
}
