/** Durable managed-file replacement. Callers must hold the profile writer lock. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeFileSynced(file: string, data: Buffer | string): Promise<void> {
  const handle = await open(file, 'w', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function existingManagedFiles(
  profileDir: string,
  names: readonly string[],
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(profileDir)
  } catch {
    return []
  }
  const wanted = new Set(names)
  return entries.filter((entry) => wanted.has(entry)).sort()
}

interface SwapFile {
  name: string
  before: string | null
  after: string | null
}
interface SwapRecord {
  version: 1
  state: 'prepared' | 'committed' | 'rolled-back'
  files: SwapFile[]
}
export interface SwapResult {
  applied: string[]
  rolledBack: boolean
}
const prefix = '.wl-staging-'
const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) &&
    !['backup', 'record.json', 'record.next', 'restore.tmp'].includes(name)
  )
}
async function regularContents(path: string): Promise<Buffer | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`not a regular managed file: ${path}`)
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function saveRecord(staging: string, record: SwapRecord): Promise<void> {
  await writeFileSynced(join(staging, 'record.next'), JSON.stringify(record))
  await rename(join(staging, 'record.next'), join(staging, 'record.json'))
  await syncDir(staging)
}
async function readRecord(staging: string): Promise<SwapRecord> {
  const stat = await lstat(staging)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid swap directory')
  const raw = await regularContents(join(staging, 'record.json'))
  if (raw === null)
    throw new Error(`incomplete swap preparation; inspect retained directory: ${staging}`)
  const record = JSON.parse(raw.toString()) as SwapRecord
  const hash = (value: unknown) =>
    value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  if (
    record.version !== 1 ||
    !['prepared', 'committed', 'rolled-back'].includes(record.state) ||
    !Array.isArray(record.files) ||
    !record.files.every(
      (file) => file && validName(file.name) && hash(file.before) && hash(file.after),
    ) ||
    new Set(record.files.map((file) => file.name)).size !== record.files.length
  )
    throw new Error(`invalid swap record: ${staging}`)
  return record
}

/** Read-only inventory, including legacy/incomplete directories; never hides corrupt records. */
export async function pendingSwaps(profileDir: string): Promise<string[]> {
  try {
    return (await readdir(profileDir)).filter((name) => name.startsWith(prefix)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Explicit recovery, under the caller's writer lock. Backups survive every failed attempt. */
export async function recoverFileSwap(
  profileDir: string,
  id: string,
): Promise<{ outcome: 'rolled-back' | 'committed' }> {
  if (!/^\.wl-staging-[a-f0-9]{12}$/.test(id)) throw new Error('invalid swap id')
  const staging = join(profileDir, id)
  const record = await readRecord(staging)
  if (record.state !== 'prepared') {
    await rm(staging, { recursive: true })
    await syncDir(profileDir)
    return { outcome: record.state }
  }
  // Validate the entire set BEFORE writing anything. A third-party edit is a conflict.
  const originals = new Map<string, Buffer | null>()
  const backupStat = await lstat(join(staging, 'backup'))
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink())
    throw new Error('invalid swap backup directory')
  for (const file of record.files) {
    const current = await regularContents(join(profileDir, file.name))
    const actual = current === null ? null : digest(current)
    if (actual !== file.before && actual !== file.after)
      throw new Error(`swap recovery conflict in ${file.name}; backups retained at ${staging}`)
    const original = await regularContents(join(staging, 'backup', file.name))
    if ((original === null ? null : digest(original)) !== file.before)
      throw new Error(`swap backup damaged for ${file.name}; retained at ${staging}`)
    originals.set(file.name, original)
  }
  for (const file of record.files) {
    const original = originals.get(file.name)!
    if (original === null) await rm(join(profileDir, file.name), { force: true })
    else {
      await writeFileSynced(join(staging, 'restore.tmp'), original)
      await rename(join(staging, 'restore.tmp'), join(profileDir, file.name))
    }
    await syncDir(profileDir)
  }
  // A crash during cleanup must not leave a prepared record with missing backups.
  await saveRecord(staging, { ...record, state: 'rolled-back' })
  await rm(staging, { recursive: true })
  await syncDir(profileDir)
  return { outcome: 'rolled-back' }
}

export async function transactionalReplaceFiles(
  profileDir: string,
  names: readonly string[],
  sourceOf: (name: string) => Promise<Buffer | string | null>,
): Promise<SwapResult> {
  if (!names.every(validName) || new Set(names).size !== names.length)
    throw new Error('invalid managed file names')
  const pending = await pendingSwaps(profileDir)
  if (pending.length)
    throw new Error(
      `unfinished managed-file swap: ${pending.join(', ')}; inspect with doctor and recover before another write`,
    )
  const id = `${prefix}${randomBytes(6).toString('hex')}`
  const staging = join(profileDir, id)
  const backup = join(staging, 'backup')
  await mkdir(staging, { mode: 0o700 })
  await mkdir(backup, { mode: 0o700 })
  let prepared = false
  let committed = false
  let commitStarted = false
  try {
    const files: SwapFile[] = []
    for (const name of names) {
      const before = await regularContents(join(profileDir, name))
      const after = await sourceOf(name)
      files.push({
        name,
        before: before === null ? null : digest(before),
        after: after === null ? null : digest(after),
      })
      if (before !== null) await writeFileSynced(join(backup, name), before)
      if (after !== null) await writeFileSynced(join(staging, name), after)
    }
    await syncDir(backup)
    const record: SwapRecord = { version: 1, state: 'prepared', files }
    await saveRecord(staging, record)
    await syncDir(profileDir)
    prepared = true
    for (const file of files) {
      const current = await regularContents(join(profileDir, file.name))
      if ((current === null ? null : digest(current)) !== file.before)
        throw new Error(`managed file changed during preparation: ${file.name}`)
    }
    for (const file of files) {
      if (file.after === null) await rm(join(profileDir, file.name), { force: true })
      else await rename(join(staging, file.name), join(profileDir, file.name))
      await syncDir(profileDir)
    }
    commitStarted = true
    await saveRecord(staging, { ...record, state: 'committed' })
    committed = true
    await rm(staging, { recursive: true })
    await syncDir(profileDir)
    return { applied: [...names], rolledBack: false }
  } catch (error) {
    if (commitStarted)
      throw new Error(
        `managed-file swap replaced all files; ${committed ? 'cleanup failed' : 'commit durability uncertain'} at ${staging}; inspect recovery record`,
        { cause: error },
      )
    try {
      if (prepared) await recoverFileSwap(profileDir, id)
      else await rm(staging, { recursive: true, force: true })
    } catch (recoveryError) {
      throw new Error(
        `managed-file swap failed; recovery incomplete, backups retained at ${staging}`,
        { cause: new AggregateError([error, recoveryError]) },
      )
    }
    throw new Error('managed-file swap failed and was rolled back', { cause: error })
  }
}
