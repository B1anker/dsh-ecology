/**
 * The mood source: pipes live agent state into the pet's mood machine.
 *
 * The plugin renders nothing on the page — its whole reason to exist is
 * deriving the pet's mood here and pushing it to the desktop app via the
 * bridge. The shell exposes agent state as two nested observables
 * (`sessions.currentProvideInfo` → `hooks.session`), so this wiring
 * subscribes to the outer one to find the inner one and re-subscribes
 * whenever the session is swapped. Every inner snapshot goes straight into
 * {@link PetStateMachine.update}, and a 1s tick drives pulse expiry and
 * sleep onset — the machine owns no timers of its own.
 *
 * Everything degrades quietly: no `sessions` service (an older shell) means
 * the pet simply idles forever, which the desktop app shows as a sleeping-in-
 * idle companion rather than an error.
 *
 * @module @seaveyon/dsh-pet/client/mood-source
 */

import type { ConversationSnapshotSlice, Observable, SessionsService } from './host-types.js'
import type { PetStateMachine } from './mood.js'

/** How often the machine's time-driven transitions (pulse expiry, sleep) run. */
export const MOOD_TICK_MS = 1000

export interface MoodSourceOptions {
  /** Defaults to {@link MOOD_TICK_MS}; injectable for tests. */
  tickMs?: number
  /**
   * Injectable scheduler for tests. Receives the tick callback and the
   * interval, returns a cancel function. Defaults to setInterval/clearInterval.
   */
  schedule?: (callback: () => void, ms: number) => () => void
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms)
  return () => clearInterval(timer)
}

/**
 * Subscribe the machine to the session provide channel. Returns one dispose
 * function that drops both subscriptions and stops the tick — wired through
 * the context's effect hook by the plugin entry.
 */
export function wireMoodSource(
  sessions: SessionsService | undefined,
  machine: PetStateMachine,
  options: MoodSourceOptions = {},
): () => void {
  const outer = sessions?.currentProvideInfo
  if (outer === undefined) return () => {}

  const tickMs = options.tickMs ?? MOOD_TICK_MS
  const schedule = options.schedule ?? defaultSchedule

  let unsubscribeInner: (() => void) | null = null
  const followInner = (inner: Observable<ConversationSnapshotSlice | null> | undefined) => {
    unsubscribeInner?.()
    unsubscribeInner = null
    if (inner === undefined) {
      machine.update(null)
      return
    }
    machine.update(inner.getSnapshot())
    unsubscribeInner = inner.subscribe(() => machine.update(inner.getSnapshot()))
  }

  const unsubscribeOuter = outer.subscribe(() => followInner(outer.getSnapshot()?.hooks?.session))
  followInner(outer.getSnapshot()?.hooks?.session)
  const cancelTick = schedule(() => machine.tick(), tickMs)

  return () => {
    unsubscribeOuter()
    unsubscribeInner?.()
    cancelTick()
  }
}
