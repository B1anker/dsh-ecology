/**
 * The overlay: the pet itself, mounted into the shell's `shell.overlay` slot.
 *
 * Data flow, in one paragraph: the shell exposes live agent state as two
 * nested observables (`sessions.currentProvideInfo` → `hooks.session`), so
 * the component subscribes to the outer one to find the inner one and
 * re-subscribes whenever the session is swapped — `useSyncExternalStore`
 * handles the unsubscribe/resubscribe edge for both levels. Snapshots feed
 * the {@link PetStateMachine} (plus a 1s `tick` for pulse expiry and sleep
 * onset), and the resulting mood picks the sprite and the bubble.
 *
 * Interaction: drag with pointer capture (clamped to the viewport, persisted
 * to localStorage on release), click or Enter/Space to pet, double-click to
 * hide behind a paw-print button that brings it back.
 *
 * @module @seaveyon/dsh-pet/client/overlay
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { clampPosition, type Position } from './geometry.js'
import type {
  ConversationSnapshotSlice,
  Observable,
  SessionMaybeProvideInfo,
  SessionsService,
} from './host-types.js'
import { getStrings } from './i18n.js'
import type { PetStateMachine } from './mood.js'
import { getPet, PET_STYLE_CSS } from './pets.js'
import type { PetSettingsStore } from './settings.js'

const POSITION_STORAGE_KEY = 'dsh-pet:pos'
const BASE_SIZE = 64
const DEFAULT_OFFSET = 24
/** Pointer travel below this counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 4

/** Hearts and the paw button are overlay chrome, not sprite internals. */
const OVERLAY_CSS = `
.dsh-pet-heart { position: absolute; left: 50%; bottom: 72%; font-size: 14px; pointer-events: none; opacity: 0; }
@keyframes dsh-pet-heart-float {
  from { transform: translate(-50%, 0) scale(0.8); opacity: 1; }
  to { transform: translate(-50%, -28px) scale(1.2); opacity: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .dsh-pet-heart { animation: dsh-pet-heart-float 1s ease-out forwards; }
}
`

export interface PetOverlayProps {
  settings: PetSettingsStore
  machine: PetStateMachine
  /** Absent when the shell predates the sessions service: the pet stays idle. */
  sessions?: SessionsService
}

const NOOP_SUBSCRIBE = () => () => {}

/** Subscribe to an observable that may not exist, React-style. */
function useOptionalObservable<T>(observable: Observable<T> | undefined | null, fallback: T): T {
  const subscribe = useCallback(
    (listener: () => void) => observable?.subscribe(listener) ?? NOOP_SUBSCRIBE(),
    [observable],
  )
  const getSnapshot = useCallback(
    () => observable?.getSnapshot() ?? fallback,
    [observable, fallback],
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}

function loadPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

function savePosition(pos: Position): void {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(pos))
  } catch {
    // Forgetting the drag position is the cheapest failure mode there is.
  }
}

// Pointer capture is real-browser API: jsdom doesn't implement it, and even
// real browsers throw for a stale pointer id. Dragging degrades gracefully.
function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    // Without capture, drags just stop tracking if the pointer leaves us.
  }
}

function releasePointer(el: Element, pointerId: number): void {
  try {
    el.releasePointerCapture(pointerId)
  } catch {
    // Symmetric with capturePointer.
  }
}

/** A tiny paw print, shown in place of a hidden pet. */
function PawIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <ellipse cx="12" cy="15.5" rx="4.5" ry="3.8" />
      <circle cx="6.2" cy="10.5" r="2" />
      <circle cx="9.8" cy="7" r="2" />
      <circle cx="14.2" cy="7" r="2" />
      <circle cx="17.8" cy="10.5" r="2" />
    </svg>
  )
}

export function PetOverlay({ settings, machine, sessions }: PetOverlayProps) {
  const strings = getStrings()
  const config = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const mood = useSyncExternalStore(machine.subscribe, machine.getSnapshot)

  // Two-level provide channel: session swap changes the outer value, which
  // re-keys the inner subscription through the useCallback dependency.
  const provideInfo = useOptionalObservable<SessionMaybeProvideInfo | null>(
    sessions?.currentProvideInfo,
    null,
  )
  const snapshot = useOptionalObservable<ConversationSnapshotSlice | null>(
    provideInfo?.hooks?.session,
    null,
  )

  useEffect(() => {
    machine.update(snapshot)
  }, [machine, snapshot])

  // Pulse expiry and sleep onset are time-driven; the machine owns no timers.
  useEffect(() => {
    const timer = setInterval(() => machine.tick(), 1000)
    return () => clearInterval(timer)
  }, [machine])

  const [pos, setPos] = useState<Position | null>(loadPosition)
  const [hidden, setHidden] = useState(false)
  const [hearts, setHearts] = useState<number[]>([])
  const drag = useRef<{
    baseX: number
    baseY: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const nextHeart = useRef(0)

  const size = BASE_SIZE * config.scale

  const pet = () => {
    machine.pet()
    const id = nextHeart.current++
    setHearts((current) => [...current, id])
    setTimeout(() => setHearts((current) => current.filter((h) => h !== id)), 1000)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = rootRef.current?.getBoundingClientRect()
    const baseX = pos?.x ?? rect?.left ?? 0
    const baseY = pos?.y ?? rect?.top ?? 0
    drag.current = { baseX, baseY, startX: event.clientX, startY: event.clientY, moved: false }
    capturePointer(event.currentTarget, event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) current.moved = true
    if (!current.moved) return
    setPos(
      clampPosition(
        current.baseX + dx,
        current.baseY + dy,
        size,
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    drag.current = null
    releasePointer(event.currentTarget, event.pointerId)
    if (current === null) return
    if (current.moved) {
      setPos((latest) => {
        if (latest !== null) savePosition(latest)
        return latest
      })
    } else {
      pet()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pet()
    }
  }

  if (!config.visible) return null

  const cornerStyle = pos
    ? { left: `${pos.x}px`, top: `${pos.y}px` }
    : { right: `${DEFAULT_OFFSET}px`, bottom: `${DEFAULT_OFFSET}px` }

  if (hidden) {
    return (
      <button
        type="button"
        aria-label={strings.restorePet}
        onClick={() => setHidden(false)}
        style={{
          position: 'fixed',
          ...cornerStyle,
          zIndex: 9999,
          padding: '6px',
          borderRadius: '50%',
          border: 'none',
          background: 'var(--dsw-color-surface, #fff)',
          color: 'var(--dsw-color-primary, #4b6bfb)',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
          cursor: 'pointer',
        }}
      >
        <PawIcon />
      </button>
    )
  }

  const toolName = mood === 'working' ? snapshot?.runningCalls[0]?.name : undefined
  const bubble = toolName ?? (mood === 'waiting' ? strings.waitingHint : null)

  return (
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label={config.name || strings.defaultPetName}
      data-dsh-pet-overlay=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => setHidden(true)}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        ...cornerStyle,
        zIndex: 9999,
        width: `${size}px`,
        height: `${size}px`,
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        outlineOffset: '2px',
      }}
    >
      <style>{PET_STYLE_CSS + OVERLAY_CSS}</style>
      {bubble !== null && (
        <div
          className="dsh-pet-bubble"
          style={{
            position: 'absolute',
            bottom: '105%',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 10px',
            borderRadius: '10px',
            background: 'var(--dsw-color-surface, #fff)',
            color: 'var(--dsw-color-text, #33363f)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {bubble}
        </div>
      )}
      {/* The sprite is a hand-built SVG string; nothing in it is user input. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sprite markup is generated by pets.ts, never from user data */}
      <div
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        dangerouslySetInnerHTML={{ __html: getPet(config.petId).svg(mood) }}
      />
      {hearts.map((id) => (
        <span key={id} className="dsh-pet-heart" aria-hidden="true">
          ❤️
        </span>
      ))}
    </div>
  )
}
