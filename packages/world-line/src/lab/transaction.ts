/** Durable promotion decisions. File bytes stay private and are removed after settlement. */
import { lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { sha256Hex } from '../fs/hash.js'
import { profileDir, worldLineDir } from '../fs/paths.js'
import { readSnapshotManifest } from '../vault/manifests.js'
import { readState, writeState } from '../vault/state.js'
import { WHITELIST_FILE_NAMES } from './create.js'
import { appendJournal, type PromotionJournalEntry } from './journal.js'
import { LAB_ID_RE, labHomeDir } from './layout.js'
import {
  pendingSwaps,
  recoverFileSwap,
  syncDir,
  transactionalReplaceFiles,
  writeFileSynced,
} from './swap.js'

export const TRANSACTION_ID_RE = /^(promotion|restore)-[A-Za-z0-9-]+$/
export type TransactionPhase =
  | 'prepared'
  | 'swapping'
  | 'swapped'
  | 'installing'
  | 'verifying'
  | 'verified'
  | 'snapshotted'
  | 'committing'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
export interface PromotionTransaction {
  version: 1
  id: string
  profileName: string
  managerHome: string
  parentLabId?: string
  labId: string
  phase: TransactionPhase
  preSnapshot: string
  afterSnapshot: string | null
  files: { name: string; before: string | null; after: string | null }[]
  entry: PromotionJournalEntry
  result?: unknown
}
const phases: TransactionPhase[] = [
  'prepared',
  'swapping',
  'swapped',
  'installing',
  'verifying',
  'verified',
  'snapshotted',
  'committing',
  'committed',
  'rolling-back',
  'rolled-back',
]
export const settled = (record: PromotionTransaction) =>
  record.phase === 'committed' || record.phase === 'rolled-back'
export function transactionDir(home: string, id: string) {
  if (!TRANSACTION_ID_RE.test(id)) throw new Error('invalid promotion transaction id')
  return join(worldLineDir(home), 'transactions', id)
}
async function bytes(path: string) {
  try {
    const s = await lstat(path)
    if (!s.isFile() || s.isSymbolicLink())
      throw new Error(`transaction file is not regular: ${path}`)
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
const hash = (value: Buffer | null) => (value === null ? null : sha256Hex(value))
export async function saveTransaction(home: string, record: PromotionTransaction) {
  const dir = transactionDir(home, record.id)
  await writeFileSynced(join(dir, 'record.next'), JSON.stringify(record))
  await rename(join(dir, 'record.next'), join(dir, 'record.json'))
  await syncDir(dir)
}
export async function readTransaction(home: string, id: string): Promise<PromotionTransaction> {
  const dir = transactionDir(home, id)
  const rootStat = await lstat(join(worldLineDir(home), 'transactions'))
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('invalid transaction root')
  const s = await lstat(dir)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('invalid transaction directory')
  const raw = await bytes(join(dir, 'record.json'))
  if (!raw) throw new Error(`incomplete transaction preparation: ${id}; retain for inspection`)
  const record = JSON.parse(raw.toString()) as PromotionTransaction
  const validHash = (value: unknown) =>
    value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
  if (
    record.version !== 1 ||
    record.id !== id ||
    !phases.includes(record.phase) ||
    typeof record.profileName !== 'string' ||
    typeof record.managerHome !== 'string' ||
    !isAbsolute(record.managerHome) ||
    !LAB_ID_RE.test(record.labId) ||
    (record.parentLabId !== undefined && !LAB_ID_RE.test(record.parentLabId)) ||
    !Array.isArray(record.files) ||
    record.files.length !== WHITELIST_FILE_NAMES.length ||
    !WHITELIST_FILE_NAMES.every(
      (name) =>
        record.files.filter((f) => f.name === name && validHash(f.before) && validHash(f.after))
          .length === 1,
    ) ||
    !record.entry ||
    record.entry.preSnapshot !== record.preSnapshot ||
    record.entry.afterSnapshot !== record.afterSnapshot ||
    !['committed', 'rolled-back'].includes(record.entry.outcome) ||
    typeof record.entry.lastKnownGood !== 'boolean' ||
    (['committing', 'committed'].includes(record.phase) &&
      (record.entry.outcome !== 'committed' ||
        record.afterSnapshot === null ||
        record.result === undefined)) ||
    record.entry.id !== id ||
    record.entry.profileName !== record.profileName ||
    record.entry.labId !== record.labId ||
    !/^snap-[A-Za-z0-9-]+$/.test(record.preSnapshot) ||
    (record.afterSnapshot !== null && !/^snap-[A-Za-z0-9-]+$/.test(record.afterSnapshot))
  )
    throw new Error(`invalid transaction record: ${id}`)
  profileDir(home, record.profileName) // Match the host's profile-name validation.
  const expected = record.parentLabId
    ? labHomeDir(record.managerHome, record.parentLabId)
    : record.managerHome
  if (resolve(expected) !== resolve(home)) throw new Error('transaction source namespace mismatch')
  return record
}
export async function listTransactions(home: string): Promise<PromotionTransaction[]> {
  const dir = join(worldLineDir(home), 'transactions')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const rootStat = await lstat(dir)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('invalid transaction root')
  const records: PromotionTransaction[] = []
  for (const id of entries) {
    if (!TRANSACTION_ID_RE.test(id))
      throw new Error('unknown transaction directory; recovery inspection required')
    records.push(await readTransaction(home, id))
  }
  return records
}
export async function prepareTransaction(
  home: string,
  record: PromotionTransaction,
  candidateDir: string,
) {
  const root = join(worldLineDir(home), 'transactions')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('invalid transaction root')
  await syncDir(worldLineDir(home))
  const dir = transactionDir(home, record.id)
  await mkdir(dir, { mode: 0o700 })
  await mkdir(join(dir, 'backup'), { mode: 0o700 })
  try {
    record.files = []
    for (const name of WHITELIST_FILE_NAMES) {
      const before = await bytes(join(profileDir(home, record.profileName), name))
      const after = await bytes(join(candidateDir, name))
      record.files.push({ name, before: hash(before), after: hash(after) })
      if (before !== null) await writeFileSynced(join(dir, 'backup', name), before)
    }
    await syncDir(join(dir, 'backup'))
    await saveTransaction(home, record)
    await syncDir(root)
  } catch (error) {
    // Preparation has not changed the profile.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
/** Replay metadata only after a durable decision; callers hold operation and vault locks. */
export async function settleTransaction(
  home: string,
  record: PromotionTransaction,
  breakStale = false,
) {
  if (!['committing', 'committed', 'rolling-back', 'rolled-back'].includes(record.phase))
    throw new Error('transaction has no settlement decision')
  if (settled(record)) {
    await rm(join(transactionDir(home, record.id), 'backup'), { recursive: true, force: true })
    return
  }
  const committed = record.phase === 'committing'
  const state = await readState(home)
  const target = committed ? record.afterSnapshot : record.preSnapshot
  if (!target) throw new Error('committing transaction has no after snapshot')
  const snapshot = await readSnapshotManifest(home, target)
  if (
    snapshot.profile.name !== record.profileName ||
    snapshot.profile.receipt.tree !==
      (committed ? record.entry.receiptAfter : record.entry.receiptBefore)
  )
    throw new Error('transaction snapshot identity mismatch')
  state.lastSnapshots[record.profileName] = target
  if (committed && record.entry.lastKnownGood) state.lastKnownGood[record.profileName] = target
  await writeState(home, state)
  await syncDir(worldLineDir(home))
  await appendJournal(record.managerHome, record.entry, breakStale)
  record.phase = committed ? 'committed' : 'rolled-back'
  await saveTransaction(home, record)
  await rm(join(transactionDir(home, record.id), 'backup'), { recursive: true, force: true })
  await syncDir(transactionDir(home, record.id))
}
/** Conservative rollback: unknown installer/external writes need manual inspection, never forced overwrite. */
export async function rollbackTransactionFiles(home: string, record: PromotionTransaction) {
  if (record.phase === 'committing' || record.phase === 'committed')
    throw new Error('commit already decided; reconcile metadata instead of rolling back')
  const dir = profileDir(home, record.profileName)
  for (const id of await pendingSwaps(dir)) await recoverFileSwap(dir, id)
  const backupDir = join(transactionDir(home, record.id), 'backup')
  const s = await lstat(backupDir)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('invalid promotion backup directory')
  const originals = new Map<string, Buffer | null>()
  for (const file of record.files) {
    const original = await bytes(join(backupDir, file.name))
    if (hash(original) !== file.before) throw new Error(`damaged promotion backup: ${file.name}`)
    const current = hash(await bytes(join(dir, file.name)))
    if (current !== file.before && current !== file.after)
      throw new Error(`promotion recovery conflict: ${file.name}; original bytes retained`)
    originals.set(file.name, original)
  }
  record.phase = 'rolling-back'
  record.entry.outcome = 'rolled-back'
  record.entry.lastKnownGood = false
  record.entry.receiptAfter = record.entry.receiptBefore
  delete record.result
  await saveTransaction(home, record)
  await transactionalReplaceFiles(
    dir,
    record.files.map((f) => f.name),
    async (name) => originals.get(name)!,
  )
}
