import { AsyncLocalStorage } from 'node:async_hooks'
import { join, resolve } from 'node:path'
import { pendingSwaps } from '../lab/swap.js'
import { listTransactions, settled } from '../lab/transaction.js'
import { sha256Hex } from './hash.js'
import { acquireLock } from './lock.js'
import { profileDir } from './paths.js'

const owned = new AsyncLocalStorage<Set<string>>()
/** Full-operation locks are distinct from short profile/vault writer locks. */
export async function withOperations<T>(
  homes: string[],
  profile: string,
  run: () => Promise<T>,
  breakStale = false,
  allowPendingSwaps = false,
): Promise<T> {
  const paths = [
    ...new Set(
      homes.map((home) =>
        join(
          resolve(home),
          'world-line',
          'locks',
          `operation-${sha256Hex(profile).slice(0, 16)}.lock`,
        ),
      ),
    ),
  ].sort()
  const prior = owned.getStore() ?? new Set<string>()
  const added = paths.filter((p) => !prior.has(p))
  const locks = []
  try {
    for (const lockPath of added)
      locks.push(
        await acquireLock({
          lockPath,
          purpose: 'world-line operation',
          breakStale,
          recoverDeadLocal: true,
        }),
      )
    if (!allowPendingSwaps && added.length > 0) {
      for (const home of homes) {
        const transactions = (await listTransactions(home)).filter(
          (record) => record.profileName === profile && !settled(record),
        )
        if (transactions.length)
          throw new Error(
            `unfinished promotion transaction: ${transactions.map((record) => record.id).join(', ')}; run recovery reconcile before another operation`,
          )
        const pending = await pendingSwaps(profileDir(home, profile))
        if (pending.length)
          throw new Error(
            `unfinished managed-file swap: ${pending.join(', ')}; run recovery before another operation`,
          )
      }
    }
    return await owned.run(new Set([...prior, ...added]), run)
  } finally {
    for (const lock of locks.reverse()) await lock.release()
  }
}
