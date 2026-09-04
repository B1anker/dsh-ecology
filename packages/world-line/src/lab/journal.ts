/**
 * Promotion journal (WORLD-LINE-SPEC §7): an append-only JSONL trail under
 * <home>/world-line/journal.jsonl recording every committed (or rolled-back)
 * promotion with its receipts and snapshot ids. Secret policy: file names,
 * receipts and ids only — never file contents or tokens.
 */

import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PromotionJournalEntry {
  id: string
  /** `promotion` (lab promote) or `restore` (restore --promote). */
  kind: 'promotion' | 'restore'
  createdAt: string
  profileName: string
  labId: string | null
  preSnapshot: string
  afterSnapshot: string | null
  outcome: 'committed' | 'rolled-back' | 'committed-restart-failed'
  receiptBefore: string
  receiptAfter: string
  /** Managed files atomically replaced. */
  files: string[]
  /** Set when a restart verification marked the after-snapshot lastKnownGood. */
  lastKnownGood: boolean
  /** Restore provenance: the snapshot the profile was rolled back to. */
  snapshotId?: string
  reason?: string
}

export function journalPath(home: string): string {
  return join(home, 'world-line', 'journal.jsonl')
}

export function newJournalId(now: Date, kind: 'promotion' | 'restore' = 'promotion'): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `${kind}-${stamp}-${randomBytes(4).toString('hex')}`
}

/** Append one line to the journal (best-effort, never throws on write). */
export async function appendJournal(home: string, entry: PromotionJournalEntry): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(home, 'world-line'), { recursive: true })
  await appendFile(journalPath(home), `${JSON.stringify(entry)}\n`, 'utf8')
}
