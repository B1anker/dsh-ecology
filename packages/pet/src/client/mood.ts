/**
 * Mood derivation and the pet's emotional state machine.
 *
 * This module is deliberately pure and DOM-free: everything time-dependent
 * goes through an injected `now()` so the whole behavior is unit-testable,
 * and nothing here subscribes to timers — the overlay drives `tick()` on an
 * interval. The split mirrors the value of the logic: the mood rules are the
 * product, the rendering is replaceable.
 *
 * Two layers of state:
 *
 * - `deriveMood` maps a ConversationSnapshot to a *base* mood, fresh on every
 *   snapshot, no memory.
 * - `PetStateMachine` layers time-based behavior on top: short-lived *pulses*
 *   (celebration when a turn lands, affection when the user pets) that
 *   override the base mood, and sleep after five unchanged idle minutes.
 *
 * @module @seaveyon/dsh-pet/client/mood
 */

import type { ConversationSnapshotSlice } from './host-types.js'

/** Every expression the pet can wear. */
export type Mood =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'sad'
  | 'sleeping'
  | 'celebrating'
  | 'pet'

/** How long a celebration pulse lasts before the base mood returns. */
export const CELEBRATE_MS = 2400

/** How long a petting pulse lasts. */
export const PET_MS = 1600

/** Idle this long with an unchanged snapshot and the pet dozes off. */
export const SLEEP_AFTER_MS = 5 * 60 * 1000

/**
 * Map a conversation snapshot to the pet's base mood.
 *
 * Branch order is the contract, and it encodes two judgments:
 *
 * 1. `pending` (queued approvals/asks) outranks `running`: when the agent is
 *    blocked on the user, "waiting" is more honest than "working", and it is
 *    the one state where the user must act.
 * 2. Errors are checked *after* the running branches. An agent that hit an
 *    error but is still running (retrying, or the error belongs to an older
 *    turn) is still at work — showing "sad" mid-run would misreport a busy
 *    agent as a stuck one. Sadness only surfaces once the agent has stopped.
 */
export function deriveMood(snapshot: ConversationSnapshotSlice): Mood {
  if (snapshot.pending.length > 0) return 'waiting'
  if (snapshot.running && snapshot.runningCalls.length > 0) return 'working'
  if (snapshot.running) return 'thinking'
  if (snapshot.promptError != null || snapshot.lastAgentError != null) return 'sad'
  return 'idle'
}

type PulseMood = 'celebrating' | 'pet'

interface Pulse {
  mood: PulseMood
  until: number
}

/**
 * Fields that count as "something changed" for the sleep timer. Turn timing
 * internals are excluded — they mutate during a run and would keep an idle
 * pet awake forever; what matters is the state a user would glance at.
 */
function fingerprint(snapshot: ConversationSnapshotSlice): string {
  return JSON.stringify([
    snapshot.running,
    snapshot.runningCalls.map((call) => call.name),
    snapshot.pending.length,
    snapshot.promptError != null,
    snapshot.lastAgentError,
    snapshot.turnEnds.size,
  ])
}

/**
 * The pet's emotional state over time.
 *
 * Implements the shell's observable shape (`getSnapshot`/`subscribe`) so the
 * overlay can subscribe with `useSyncExternalStore` directly. Time only
 * enters through the injected clock and only advances the state on an
 * explicit `update`/`pet`/`tick` call — the machine never starts timers,
 * which keeps tests deterministic and the shell free of stray intervals
 * after the overlay unmounts.
 */
export class PetStateMachine {
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private baseMood: Mood = 'idle'
  private pulse: Pulse | null = null
  private mood: Mood = 'idle'
  private lastFingerprint = ''
  private lastChangeAt: number
  private prevTurnEndCount = 0
  // The first snapshot of a session establishes the turn baseline; only
  // *growth from a baseline we witnessed* is a finished turn worth a party.
  private needsBaseline = true

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.lastChangeAt = this.now()
  }

  /** The current mood. Cached between notifications, as React requires. */
  getSnapshot = (): Mood => this.mood

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Feed a fresh conversation snapshot. `null` means no current session: the
   * pet falls back to idle and forgets turn bookkeeping, so returning to a
   * session later doesn't fire a stale celebration.
   */
  update(snapshot: ConversationSnapshotSlice | null): void {
    if (snapshot === null) {
      this.prevTurnEndCount = 0
      this.needsBaseline = true
      // The session is gone; a pulse still playing would celebrate nothing.
      this.pulse = null
      this.setBase('idle', '')
      this.resolve()
      return
    }

    const count = snapshot.turnEnds.size
    if (this.needsBaseline) {
      // First sighting of a session (startup, or after a swap): whatever turn
      // history it already carries is not ours to celebrate.
      this.needsBaseline = false
      this.prevTurnEndCount = count
    } else if (count > this.prevTurnEndCount && !snapshot.running) {
      // A celebration is a turn that *finished*: the end marker appeared and
      // the agent is no longer running. Growth mid-run is just bookkeeping.
      this.startPulse('celebrating', CELEBRATE_MS)
    }
    this.prevTurnEndCount = count

    this.setBase(deriveMood(snapshot), fingerprint(snapshot))
    this.resolve()
  }

  /** The user petted the pet: an affection pulse, regardless of agent state. */
  pet(): void {
    this.startPulse('pet', PET_MS)
    this.resolve()
  }

  /**
   * Advance time-driven transitions (pulse expiry, sleep onset) without a new
   * snapshot. The overlay calls this on a 1s interval; tests call it after
   * moving their fake clock.
   */
  tick(): void {
    this.resolve()
  }

  private setBase(base: Mood, print: string): void {
    this.baseMood = base
    if (print !== this.lastFingerprint) {
      this.lastFingerprint = print
      this.lastChangeAt = this.now()
    }
  }

  private startPulse(mood: PulseMood, durationMs: number): void {
    this.pulse = { mood, until: this.now() + durationMs }
  }

  /** Recompute the effective mood from base + pulse + sleep, then notify. */
  private resolve(): void {
    const now = this.now()
    if (this.pulse !== null && now >= this.pulse.until) this.pulse = null

    let next: Mood
    if (this.pulse !== null) {
      next = this.pulse.mood
    } else if (this.baseMood === 'idle' && now - this.lastChangeAt >= SLEEP_AFTER_MS) {
      // Only a truly idle, untouched conversation dozes off; any activity or
      // error keeps the pet awake and honest about it.
      next = 'sleeping'
    } else {
      next = this.baseMood
    }

    if (next === this.mood) return
    this.mood = next
    for (const listener of Array.from(this.listeners)) listener()
  }
}
