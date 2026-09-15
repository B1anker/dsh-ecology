/**
 * The mood source: pipes live agent state into the pet's mood machine.
 *
 * The plugin renders nothing on the page — its whole reason to exist is
 * deriving the pet's mood here and pushing it to the desktop app via the
 * bridge. Every snapshot goes straight into {@link PetStateMachine.update},
 * and a 1s tick drives pulse expiry and sleep onset — the machine owns no
 * timers of its own.
 *
 * The shell has exposed live agent state in two shapes, and this module
 * speaks both (see `host-types.ts` for where each was verified):
 *
 * - DSH ≤ 0.1.2: `sessions.currentProvideInfo` → `hooks.session`, two nested
 *   observables. The outer one is followed to find the inner one, which is
 *   re-subscribed whenever the session is swapped.
 * - DSH 0.1.5+: `sessions.list` carries the current session id, and
 *   `sessions.binding(id).session` is the observable session face. The face
 *   only exposes session-level state (`running`, the two error slots), so the
 *   conversation-level members the machine reads are synthesized: no tool
 *   calls or pending asks are visible (the pet thinks rather than works or
 *   waits), and a turn end is inferred from the running bit falling.
 *
 * Everything degrades quietly: no `sessions` service, or one in a shape this
 * module does not know, means the pet simply idles forever, which the desktop
 * app shows as a sleeping-in-idle companion rather than an error.
 *
 * @module @seaveyon/dsh-pet/client/mood-source
 */

import type {
  ConversationSnapshotSlice,
  Observable,
  SessionListStateSlice,
  SessionSnapshotSlice,
  SessionsService,
} from './host-types.js'
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
  /** Clock for synthesized turn-end timestamps; injectable for tests. */
  now?: () => number
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms)
  return () => clearInterval(timer)
}

/** Which live-state surface a `sessions` service offers, if any. */
export type SessionsShape = 'provide-info' | 'binding' | 'unknown'

/**
 * Classify a `sessions` service by the surface it exposes. The ≤ 0.1.2
 * channel wins when both are present, because it carries the richer
 * conversation snapshot; the 0.1.5+ pair needs both `list` and `binding`.
 */
export function detectSessionsShape(sessions: SessionsService | undefined): SessionsShape {
  if (sessions === undefined) return 'unknown'
  if (sessions.currentProvideInfo !== undefined) return 'provide-info'
  if (sessions.list !== undefined && typeof sessions.binding === 'function') return 'binding'
  return 'unknown'
}

const EMPTY_CALLS: readonly { name: string }[] = []
const EMPTY_PENDING: readonly unknown[] = []
const EMPTY_TIMINGS: ReadonlyMap<
  number,
  { readonly startTime: number; readonly endTime?: number }
> = new Map()

/**
 * Per-session bookkeeping that turns a 0.1.5+ session face into the
 * conversation slice the machine reads. `turnEnds` grows by one each time
 * `running` falls, which is the edge the machine celebrates on; nothing else
 * in the slice can be known from the face and is reported as empty.
 */
export class SessionFaceAdapter {
  private wasRunning = false
  private readonly turnEnds = new Map<number, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Translate one face snapshot (or a list row) into the machine's slice. */
  adapt(snapshot: SessionSnapshotSlice): ConversationSnapshotSlice {
    if (this.wasRunning && !snapshot.running) {
      this.turnEnds.set(this.turnEnds.size, this.now())
    }
    this.wasRunning = snapshot.running
    return {
      running: snapshot.running,
      runningCalls: EMPTY_CALLS,
      pending: EMPTY_PENDING,
      promptError: snapshot.promptError ?? null,
      lastAgentError: snapshot.lastAgentError ?? null,
      turnEnds: this.turnEnds,
      turnTimings: EMPTY_TIMINGS,
    }
  }
}

/**
 * Subscribe the machine to whichever live-state surface the shell offers.
 * Returns one dispose function that drops every subscription and stops the
 * tick — wired through the context's effect hook by the plugin entry.
 */
export function wireMoodSource(
  sessions: SessionsService | undefined,
  machine: PetStateMachine,
  options: MoodSourceOptions = {},
): () => void {
  const shape = detectSessionsShape(sessions)
  if (sessions === undefined || shape === 'unknown') return () => {}

  const tickMs = options.tickMs ?? MOOD_TICK_MS
  const schedule = options.schedule ?? defaultSchedule
  const unsubscribeSource =
    shape === 'provide-info'
      ? followProvideInfo(sessions, machine)
      : followBinding(sessions, machine, options.now ?? Date.now)
  const cancelTick = schedule(() => machine.tick(), tickMs)

  return () => {
    unsubscribeSource()
    cancelTick()
  }
}

/** DSH ≤ 0.1.2: follow the outer channel to the inner conversation observable. */
function followProvideInfo(sessions: SessionsService, machine: PetStateMachine): () => void {
  const outer = sessions.currentProvideInfo
  if (outer === undefined) return () => {}

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

  return () => {
    unsubscribeOuter()
    unsubscribeInner?.()
  }
}

/**
 * DSH 0.1.5+: follow `list.current` to the bound session face. A session the
 * list names but has not materialized yet (`binding` returns undefined) is
 * read from its list row until the next list revision, when the binding is
 * retried — the shell bumps the list when an instance arrives.
 */
function followBinding(
  sessions: SessionsService,
  machine: PetStateMachine,
  now: () => number,
): () => void {
  const list = sessions.list
  const binding = sessions.binding
  if (list === undefined || binding === undefined) return () => {}

  let followedId: string | undefined
  let followedFace: Observable<SessionSnapshotSlice> | null = null
  let unsubscribeFace: (() => void) | null = null
  let adapter: SessionFaceAdapter | null = null

  const dropFace = () => {
    unsubscribeFace?.()
    unsubscribeFace = null
    followedFace = null
  }

  const readList = (state: SessionListStateSlice) => {
    const current = state.current
    if (current !== followedId) {
      dropFace()
      followedId = current
      adapter = current === undefined ? null : new SessionFaceAdapter(now)
    }
    if (current === undefined || adapter === null) {
      machine.update(null)
      return
    }

    const face = binding(current)?.session
    if (face !== undefined && face !== followedFace) {
      dropFace()
      followedFace = face
      const push = () => {
        if (adapter !== null) machine.update(adapter.adapt(face.getSnapshot()))
      }
      unsubscribeFace = face.subscribe(push)
      push()
      return
    }
    if (face === undefined) {
      // Not materialized yet: the list row still knows whether it is running.
      const row = state.byId?.[current]
      machine.update(adapter.adapt({ running: row?.running === true }))
    }
  }

  const unsubscribeList = list.subscribe(() => readList(list.getSnapshot()))
  readList(list.getSnapshot())

  return () => {
    unsubscribeList()
    dropFace()
  }
}
