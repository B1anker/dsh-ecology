import type { CliContext } from '../context.js'
import { acquireLock } from '../fs/lock.js'
import { withOperations } from '../fs/operation.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { pendingSwaps, recoverFileSwap } from '../lab/swap.js'
import {
  listTransactions,
  readTransaction,
  rollbackTransactionFiles,
  settled,
  settleTransaction,
} from '../lab/transaction.js'

/** Recovery never replays plugin commands or treats restored files as a healthy runtime. */
export async function runRecovery(ctx: CliContext, id?: string) {
  const dir = profileDir(ctx.home, ctx.profileName)
  if (id === undefined)
    return {
      profile: ctx.profileName,
      swaps: await pendingSwaps(dir),
      transactions: (await listTransactions(ctx.home))
        .filter((record) => record.profileName === ctx.profileName)
        .map((record) => ({
          id: record.id,
          phase: record.phase,
          labId: record.labId,
          pending: !settled(record),
        })),
    }
  return withOperations(
    [ctx.home],
    ctx.profileName,
    async () => {
      const lock = await acquireLock({
        lockPath: profileLockPath(ctx.home, ctx.profileName),
        purpose: 'recover interrupted managed-file swap',
        breakStale: ctx.breakStaleLock,
      })
      try {
        return { id, ...(await recoverFileSwap(dir, id)), runtimeVerified: false }
      } finally {
        await lock.release()
      }
    },
    ctx.breakStaleLock,
    true,
  )
}

/** Roll back undecided transactions, or finish a durable commit decision. Never reinstall/restart. */
export async function reconcilePromotion(ctx: CliContext, id: string, runtimeStopped = false) {
  const record = await readTransaction(ctx.home, id)
  if (record.profileName !== ctx.profileName) throw new Error('transaction profile mismatch')
  return withOperations(
    [ctx.home],
    ctx.profileName,
    async () => {
      // Re-read after lock acquisition: another recovery might have finished while we waited.
      const current = await readTransaction(ctx.home, id)
      if (['installing', 'verifying'].includes(current.phase) && !runtimeStopped)
        throw new Error(
          'installer or verification process may still be running; stop it first, then explicitly confirm with --runtime-stopped',
        )
      if (current.phase !== 'committing' && !settled(current)) {
        const lock = await acquireLock({
          lockPath: profileLockPath(ctx.home, ctx.profileName),
          purpose: 'recover promotion',
          breakStale: ctx.breakStaleLock,
        })
        try {
          await rollbackTransactionFiles(ctx.home, current)
        } finally {
          await lock.release()
        }
      }
      await withOperations(
        [ctx.home],
        'vault',
        () => settleTransaction(ctx.home, current, ctx.breakStaleLock),
        ctx.breakStaleLock,
      )
      return {
        id,
        outcome: current.phase,
        runtimeVerified: false,
        action: 'metadata-and-managed-files-only',
      }
    },
    ctx.breakStaleLock,
    true,
  )
}
