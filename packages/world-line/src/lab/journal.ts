/**
 * Promotion journal (WORLD-LINE-SPEC §7): an append-only JSONL trail under
 * <home>/world-line/journal.jsonl recording every committed (or rolled-back)
 * promotion with its receipts and snapshot ids. Secret policy: file names,
 * receipts and ids only — never file contents or tokens.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLock } from '../fs/lock.js'
import { readTextIfExists } from '../fs/read-json.js'
import { syncDir } from './swap.js'

export interface PromotionJournalEntry {
  reviewAcceptance?: {
    acceptedAt: string
    policyVersion: 2
    unresolvedChecks: string[]
    labId: string
  }
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

/** Durable, idempotent append. A torn or conflicting journal requires inspection. */
export async function appendJournal(
  home: string,
  entry: PromotionJournalEntry,
  breakStale = false,
): Promise<void> {
  const dir = join(home, 'world-line')
  await mkdir(dir, { recursive: true })
  const lock = await acquireLock({
    lockPath: join(dir, 'locks', 'journal.lock'),
    purpose: 'append promotion journal',
    breakStale,
  })
  try {
    const raw = (await readTextIfExists(journalPath(home))) ?? ''
    if (raw && !raw.endsWith('\n'))
      throw new Error('incomplete promotion journal tail; inspection required')
    for (const line of raw.split('\n').filter(Boolean)) {
      const prior = JSON.parse(line) as PromotionJournalEntry
      if (prior.id === entry.id) {
        if (JSON.stringify(prior) !== JSON.stringify(entry))
          throw new Error('conflicting promotion journal entry')
        const handle = await open(journalPath(home), 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await syncDir(dir)
        return
      }
    }
    const handle = await open(journalPath(home), 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDir(dir)
  } finally {
    await lock.release()
  }
}
