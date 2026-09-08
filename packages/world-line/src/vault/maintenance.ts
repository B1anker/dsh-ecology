import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { sha256Hex } from '../fs/hash.js'
import { withOperations } from '../fs/operation.js'
import { objectsDir, snapshotsDir, worldLineDir } from '../fs/paths.js'
import { listSnapshotManifests } from './manifests.js'
import { recoveryReferences } from './references.js'

export interface StorageSize {
  logicalBytes: number
  allocatedBytes: number
  files: number
  warnings: string[]
  at: string
  groups: Record<string, { logicalBytes: number; allocatedBytes: number; files: number }>
}
const scans = new Map<string, { at: number; value: Promise<StorageSize> }>()
export function storageUsage(home: string): Promise<StorageSize> {
  const cached = scans.get(home)
  if (cached && Date.now() - cached.at < 60000) return cached.value
  const value = (async () => {
    const total: StorageSize = {
      logicalBytes: 0,
      allocatedBytes: 0,
      files: 0,
      warnings: [],
      at: new Date().toISOString(),
      groups: {},
    }
    const seen = new Set<string>()
    const walk = async (path: string, group: string): Promise<void> => {
      try {
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
          for (const name of await readdir(path)) await walk(join(path, name), group || name)
          return
        }
        if (!stat.isFile()) return
        const key = `${stat.dev}:${stat.ino}`
        if (seen.has(key)) return
        seen.add(key)
        const g = (total.groups[group] ??= { logicalBytes: 0, allocatedBytes: 0, files: 0 })
        const allocated = (stat.blocks ?? Math.ceil(stat.size / 512)) * 512
        g.logicalBytes += stat.size
        g.allocatedBytes += allocated
        g.files++
        total.logicalBytes += stat.size
        total.allocatedBytes += allocated
        total.files++
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
          total.warnings.push(`无法完整统计 ${path}`)
      }
    }
    const root = worldLineDir(home)
    let names: string[] = []
    try {
      names = await readdir(root)
    } catch {}
    for (const name of names) {
      try {
        if (['labs', 'rescues', 'vault'].includes(name)) {
          const dir = join(root, name)
          if ((await lstat(dir)).isSymbolicLink()) continue
          for (const child of await readdir(dir)) await walk(join(dir, child), `${name}/${child}`)
        } else await walk(join(root, name), name)
      } catch {
        total.warnings.push(`无法完整统计 ${name}`)
      }
    }
    return total
  })()
  scans.set(home, { at: Date.now(), value })
  return value
}
export interface GcPlan {
  revision: string
  objects: { id: string; bytes: number }[]
  logicalBytes: number
  at: string
}
async function safeDirectory(path: string, optional = false) {
  try {
    const s = await lstat(path)
    if (!s.isDirectory() || s.isSymbolicLink())
      throw new UsageError('存储目录不是普通目录，停止操作')
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
}
async function safeFile(path: string) {
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink()) throw new UsageError('存储包含非普通文件，停止操作')
  return s
}
async function validateVault(home: string) {
  await safeDirectory(worldLineDir(home), true)
  await safeDirectory(join(worldLineDir(home), 'vault'), true)
  await safeDirectory(objectsDir(home), true)
  await safeDirectory(snapshotsDir(home), true)
  let names: string[] = []
  try {
    names = await readdir(snapshotsDir(home))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  for (const name of names) {
    if (!/^snap-[A-Za-z0-9-]+\.json$/.test(name))
      throw new UsageError('快照目录含未知文件，停止回收')
    await safeFile(join(snapshotsDir(home), name))
  }
}
async function planUnlocked(home: string): Promise<GcPlan> {
  await validateVault(home)
  const { snapshots, corrupt } = await listSnapshotManifests(home)
  if (corrupt.length) throw new UsageError('存在损坏快照，停止回收，请先诊断')
  const pins = await recoveryReferences(home)
  const snapshotIds = new Set(snapshots.map((s) => s.id))
  if ([...pins].some((id) => !snapshotIds.has(id)))
    throw new UsageError('存在缺失的恢复快照引用，停止回收')
  const referenced = new Set<string>()
  for (const snapshot of snapshots) {
    if (
      snapshot.formatVersion !== 1 ||
      !Array.isArray(snapshot.files) ||
      !snapshot.profile ||
      !Object.hasOwn(snapshot, 'homePatch')
    )
      throw new UsageError('快照引用结构不完整，停止回收')
    for (const file of snapshot.files) {
      if (!file || typeof file !== 'object' || !Object.hasOwn(file, 'object'))
        throw new UsageError('快照文件引用不完整')
      if (file.object) {
        if (!/^[a-f0-9]{64}$/.test(file.object)) throw new UsageError('对象引用无效')
        referenced.add(file.object)
      }
    }
    if (snapshot.homePatch?.object) referenced.add(snapshot.homePatch.object)
  }
  for (const id of referenced) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new UsageError('对象引用无效')
    try {
      await safeFile(join(objectsDir(home), id))
    } catch {
      throw new UsageError('快照引用对象缺失，停止回收，请先恢复隔离对象或诊断')
    }
  }
  const candidates: GcPlan['objects'] = []
  let names: string[] = []
  try {
    names = await readdir(objectsDir(home))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  for (const id of names.sort()) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new UsageError('对象目录包含未知文件，停止回收')
    const stat = await lstat(join(objectsDir(home), id))
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new UsageError('对象目录包含非普通文件，停止回收')
    if (!referenced.has(id)) candidates.push({ id, bytes: stat.size })
  }
  const roots = await Promise.all(
    snapshots.map((s) => readFile(join(snapshotsDir(home), `${s.id}.json`), 'utf8')),
  )
  return {
    revision: sha256Hex(
      JSON.stringify({ roots: roots.sort(), pins: [...pins].sort(), candidates }),
    ),
    objects: candidates,
    logicalBytes: candidates.reduce((a, b) => a + b.bytes, 0),
    at: new Date().toISOString(),
  }
}
export async function gcPreview(home: string) {
  return withOperations([home], 'vault', () => planUnlocked(home))
}
export async function gcApply(home: string, revision: string) {
  return withOperations([home], 'vault', async () => {
    const plan = await planUnlocked(home)
    if (plan.revision !== revision) throw new UsageError('存储已变化，请重新预览回收计划')
    const id = `gc-${Date.now()}-${randomBytes(4).toString('hex')}`
    const dir = join(worldLineDir(home), 'quarantine', id)
    await safeDirectory(join(worldLineDir(home), 'quarantine'), true)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(join(dir, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
    // The immutable manifest set is the complete object reference namespace in this vault.
    // No manifests are deleted here; lab/journal snapshot references remain backed by their manifests.
    for (const object of plan.objects)
      await rename(join(objectsDir(home), object.id), join(dir, object.id))
    scans.delete(home)
    return {
      id,
      moved: plan.objects.length,
      logicalBytes: plan.logicalBytes,
      note: '对象已隔离，可恢复；尚未释放磁盘空间。',
    }
  })
}
export async function gcRestore(home: string, id: string) {
  if (!/^gc-\d+-[a-f0-9]{8}$/.test(id)) throw new UsageError('无效回收记录')
  return withOperations([home], 'vault', async () => {
    await validateVault(home)
    const dir = join(worldLineDir(home), 'quarantine', id)
    await safeDirectory(join(worldLineDir(home), 'quarantine'))
    await safeDirectory(dir)
    const names = await readdir(dir)
    await mkdir(objectsDir(home), { recursive: true })
    let restored = 0
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      await safeFile(join(dir, name))
      const bytes = await readFile(join(dir, name))
      if (sha256Hex(bytes) !== name) throw new UsageError('隔离对象校验失败')
      try {
        await safeFile(join(objectsDir(home), name))
        if (sha256Hex(await readFile(join(objectsDir(home), name))) !== name)
          throw new UsageError('现有对象校验失败')
        continue
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      await rename(join(dir, name), join(objectsDir(home), name))
      restored++
    }
    scans.delete(home)
    return { restored }
  })
}

export async function gcPurge(home: string, id: string) {
  if (!/^gc-\d+-[a-f0-9]{8}$/.test(id)) throw new UsageError('无效回收记录')
  return withOperations([home], 'vault', async () => {
    const dir = join(worldLineDir(home), 'quarantine', id)
    await validateVault(home)
    await safeDirectory(join(worldLineDir(home), 'quarantine'))
    await safeDirectory(dir)
    await safeFile(join(dir, 'plan.json'))
    const plan = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')) as GcPlan
    if (
      !Array.isArray(plan.objects) ||
      plan.objects.some((o) => !o || !/^[a-f0-9]{64}$/.test(o.id))
    )
      throw new UsageError('隔离计划无效')
    if (!Number.isFinite(Date.parse(plan.at)) || Date.now() - Date.parse(plan.at) < 7 * 86400000)
      throw new UsageError('隔离对象至少保留 7 天后才能永久删除')
    const { snapshots, corrupt } = await listSnapshotManifests(home)
    if (corrupt.length) throw new UsageError('存在损坏快照，停止删除')
    const ids = new Set(plan.objects.map((o) => o.id))
    if (
      snapshots.some(
        (s) =>
          s.files.some((f) => f.object && ids.has(f.object)) ||
          (s.homePatch?.object && ids.has(s.homePatch.object)),
      )
    )
      throw new UsageError('隔离对象被快照引用，请先恢复')
    const names = await readdir(dir)
    if (names.some((n) => n !== 'plan.json' && !/^[a-f0-9]{64}$/.test(n)))
      throw new UsageError('隔离目录包含未知文件')
    for (const name of names) {
      await safeFile(join(dir, name))
      if (name !== 'plan.json' && !ids.has(name)) throw new UsageError('隔离对象不在回收计划中')
    }
    await rm(dir, { recursive: true, force: false })
    scans.delete(home)
    return { deleted: id }
  })
}

export async function gcRecords(home: string) {
  const root = join(worldLineDir(home), 'quarantine')
  await safeDirectory(root, true)
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const records = []
  for (const id of names
    .filter((n) => /^gc-\d+-[a-f0-9]{8}$/.test(n))
    .sort()
    .reverse()) {
    const dir = join(root, id)
    await safeDirectory(dir)
    await safeFile(join(dir, 'plan.json'))
    const plan = JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')) as GcPlan
    const remaining = (await readdir(dir)).filter((n) => /^[a-f0-9]{64}$/.test(n)).length
    records.push({
      id,
      at: plan.at,
      remaining,
      logicalBytes: plan.logicalBytes,
      canPurge: Date.now() - Date.parse(plan.at) >= 7 * 86400000,
    })
  }
  return records
}
