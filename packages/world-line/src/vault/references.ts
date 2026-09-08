import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from '../domain/errors.js'
import { worldLineDir } from '../fs/paths.js'
import { LAB_ID_RE } from '../lab/layout.js'
import { listTransactions } from '../lab/transaction.js'
/** Conservative local-vault pins; unknown or damaged recovery metadata fails closed. */
export async function recoveryReferences(home: string): Promise<Set<string>> {
  const refs = new Set<string>(),
    root = worldLineDir(home)
  const add = (id: unknown) => {
    if (id === null || id === undefined) return
    if (typeof id !== 'string' || !/^snap-[A-Za-z0-9-]+$/.test(id))
      throw new UsageError('恢复引用无效，停止清理')
    refs.add(id)
  }
  const read = async (path: string) => {
    try {
      const s = await lstat(path)
      if (!s.isFile() || s.isSymbolicLink()) throw new UsageError('恢复元数据不是普通文件')
      return await readFile(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  try {
    for (const record of await listTransactions(home)) {
      add(record.preSnapshot)
      add(record.afterSnapshot)
      add(record.entry.snapshotId)
    }
    const pins = await readdir(join(root, 'workflow-pins')).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    for (const name of pins) {
      if (!/^bisect-[a-f0-9-]{36}\.json$/.test(name)) throw new UsageError('Unknown workflow pin')
      const pin = JSON.parse((await read(join(root, 'workflow-pins', name))) ?? 'null')
      if (pin?.version !== 1 || !Array.isArray(pin.snapshots))
        throw new UsageError('Invalid workflow pin')
      pin.snapshots.forEach(add)
    }
    const state = await read(join(root, 'state.json'))
    if (state) {
      const value = JSON.parse(state)
      if (value.formatVersion !== 1) throw new UsageError('未知恢复状态版本')
      for (const field of ['lastKnownGood', 'lastSnapshots']) {
        if (!value[field] || typeof value[field] !== 'object')
          throw new UsageError('恢复状态结构不完整')
        Object.values(value[field]).forEach(add)
      }
    }
    const journal = await read(join(root, 'journal.jsonl'))
    if (journal)
      for (const line of journal.split('\n').filter(Boolean)) {
        const row = JSON.parse(line)
        if (!['promotion', 'restore'].includes(row.kind))
          throw new UsageError('未知事务类型，停止清理')
        add(row.preSnapshot)
        add(row.afterSnapshot)
        add(row.snapshotId)
      }
    let labs: string[] = []
    try {
      labs = await readdir(join(root, 'labs'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    for (const id of labs.filter((id) => LAB_ID_RE.test(id))) {
      const raw = await read(join(root, 'labs', id, 'manifest.json'))
      if (!raw) throw new UsageError('实验记录缺失，停止清理')
      const lab = JSON.parse(raw)
      if (lab.manifestVersion !== 1 || !lab.source) throw new UsageError('未知实验记录，停止清理')
      if (lab.state === 'destroyed' || lab.source.parentLabId) continue
      add(lab.source.snapshotId)
      add(lab.source.baselineSnapshotId)
    }
  } catch (e) {
    throw new UsageError(`无法完整读取恢复引用：${e instanceof Error ? e.message : String(e)}`)
  }
  return refs
}
