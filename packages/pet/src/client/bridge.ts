/**
 * The desktop-companion bridge: pushes pet state to a standalone desktop app.
 *
 * The desktop app (zero-native, a Zig shell) listens on loopback and exposes
 * `POST /state` to receive the pet's current state. This bridge subscribes to
 * the mood machine and the settings store, and whenever the observable state
 * (mood, pet species, name) actually changes it POSTs the snapshot as JSON.
 *
 * The companion is a pure side channel and strictly fire-and-forget: the
 * desktop app may be absent, the port closed, the request blocked — every
 * failure is swallowed silently. Nothing here throws, logs, or otherwise
 * touches the plugin's own behavior, and not one request is made while the
 * `companionEnabled` setting is off (it is on by default: driving the desktop
 * pet is the plugin's whole job).
 *
 * @module @seaveyon/dsh-pet/client/bridge
 */

import { MOODS } from '../desktop.js'
import type { Mood, PetStateMachine } from './mood.js'
import type { PetSettingsStore } from './settings.js'

/**
 * Contract with the desktop app: it serves `POST /state` on this loopback
 * port, accepting a JSON {@link DesktopBridgeState} body. The port is fixed
 * on both sides; changing it here without changing the app breaks the pair.
 */
export const DESKTOP_COMPANION_PORT = 45731

export const DEFAULT_ENDPOINT = `http://127.0.0.1:${DESKTOP_COMPANION_PORT}/state`

/** The bridge server's origin: `GET /pets` and the sprite strips live here. */
export const DESKTOP_BASE_URL = `http://127.0.0.1:${DESKTOP_COMPANION_PORT}`

/**
 * How long pet discovery may take before the plugin settles for the built-in
 * roster. The desktop app not running is the normal case, and it must never
 * stall the settings panel.
 */
export const DESKTOP_PETS_TIMEOUT_MS = 800

/** One mood of an imported pet: a horizontal strip of square frames. */
export interface DesktopPetMoodSprite {
  /** Frame count; the strip is `frames` times as wide as it is tall. */
  frames: number
  /** How long each frame shows. */
  frameDurationMs: number
  /**
   * Absolute sprite-strip URL. The wire format is relative (`/sprites/...`);
   * {@link fetchDesktopPets} resolves it against the bridge origin so renderers
   * never need to know where the server lives.
   */
  url: string
}

/** An imported (bitmap) pet advertised by the desktop app. */
export interface DesktopPet {
  id: string
  /** One strip per mood; a pet missing any mood is dropped during parsing. */
  moods: Record<Mood, DesktopPetMoodSprite>
}

export interface FetchDesktopPetsOptions {
  /** Defaults to {@link DESKTOP_BASE_URL}; injectable for tests. */
  baseUrl?: string
  /** Defaults to the global fetch; injectable for tests. */
  fetchFn?: typeof fetch
  /** Defaults to {@link DESKTOP_PETS_TIMEOUT_MS}; injectable for tests. */
  timeoutMs?: number
}

/** Narrow one wire sprite entry; anything off-contract drops it. */
function parseMoodSprite(raw: unknown, baseUrl: string): DesktopPetMoodSprite | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const frames = record['frames']
  const frameDurationMs = record['frameDurationMs']
  const url = record['url']
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1) return null
  // The desktop manifest carries fractional durations (6000ms / 7 frames), so
  // any positive finite number goes.
  if (typeof frameDurationMs !== 'number' || frameDurationMs <= 0) return null
  if (typeof url !== 'string' || !url.startsWith('/')) return null
  return { frames, frameDurationMs, url: `${baseUrl}${url}` }
}

/**
 * Narrow the `GET /pets` body. A body that is not the documented envelope is
 * a protocol violation (`null`); an envelope whose individual pets are broken
 * keeps the healthy ones — one truncated import should not hide the rest.
 */
function parseDesktopPets(body: unknown, baseUrl: string): DesktopPet[] | null {
  if (typeof body !== 'object' || body === null) return null
  const list = (body as Record<string, unknown>)['pets']
  if (!Array.isArray(list)) return null
  const pets: DesktopPet[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = record['id']
    const rawMoods = record['moods']
    if (typeof id !== 'string' || id === '' || typeof rawMoods !== 'object' || rawMoods === null) {
      continue
    }
    const moodMap = rawMoods as Record<string, unknown>
    const moods = {} as Record<Mood, DesktopPetMoodSprite>
    let complete = true
    for (const mood of MOODS) {
      const sprite = parseMoodSprite(moodMap[mood], baseUrl)
      if (sprite === null) {
        complete = false
        break
      }
      moods[mood] = sprite
    }
    if (complete) pets.push({ id, moods })
  }
  return pets
}

/**
 * Discover the imported pets the desktop app is currently serving.
 *
 * Returns the roster on success and `null` on every failure — app not
 * running, timeout, non-200, unreadable JSON. The distinction matters: `null`
 * means "desktop unreachable, keep whatever list we had", while an empty
 * array means "desktop is up and has nothing imported".
 */
export async function fetchDesktopPets(
  options: FetchDesktopPetsOptions = {},
): Promise<DesktopPet[] | null> {
  const baseUrl = options.baseUrl ?? DESKTOP_BASE_URL
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? DESKTOP_PETS_TIMEOUT_MS

  const controller = new AbortController()
  // Every error inside run() — including a fetch implementation that throws
  // synchronously — collapses to null, so the raced promise can never reject
  // after the timeout wins and nobody is left awaiting it.
  const run = async (): Promise<DesktopPet[] | null> => {
    try {
      const response = await fetchFn(`${baseUrl}/pets`, { signal: controller.signal })
      if (!response.ok) return null
      return parseDesktopPets(await response.json(), baseUrl)
    } catch {
      return null
    }
  }
  let timer!: ReturnType<typeof setTimeout>
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })
  const result = await Promise.race([run(), expired])
  clearTimeout(timer)
  return result
}

/** The state snapshot the desktop app receives. */
export interface DesktopBridgeState {
  mood: Mood
  petId: string
  name: string
}

export interface DesktopBridgeOptions {
  settings: PetSettingsStore
  machine: PetStateMachine
  /** Defaults to {@link DEFAULT_ENDPOINT}; injectable for tests. */
  endpoint?: string
  /** Defaults to the global fetch; injectable for tests. */
  fetchFn?: typeof fetch
}

/**
 * Wires the two observables to the POST. Both subscriptions converge on one
 * handler: read the current state, dedupe it against what was last sent, and
 * send. The constructor fires the handler once so an already-enabled page
 * announces its state on load; a disabled bridge sends nothing, ever.
 */
export class DesktopBridge {
  private readonly settings: PetSettingsStore
  private readonly machine: PetStateMachine
  private readonly endpoint: string
  private readonly fetchFn: typeof fetch
  private readonly unsubscribes: (() => void)[]
  private lastSent = ''

  constructor(options: DesktopBridgeOptions) {
    this.settings = options.settings
    this.machine = options.machine
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.unsubscribes = [
      options.settings.subscribe(this.push),
      options.machine.subscribe(this.push),
    ]
    this.push()
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
  }

  /**
   * The single notification handler. Builds the payload, skips it if nothing
   * changed since the last send, and otherwise POSTs it. The `.catch` (and
   * the try around the call itself, for fetch implementations that throw
   * synchronously) is the whole error story: the desktop app is optional, so
   * its absence must be invisible.
   */
  private push = (): void => {
    const config = this.settings.getSnapshot()
    if (!config.companionEnabled) return

    const state: DesktopBridgeState = {
      mood: this.machine.getSnapshot(),
      petId: config.petId,
      name: config.name,
    }
    const body = JSON.stringify(state)
    if (body === this.lastSent) return
    this.lastSent = body

    try {
      this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).catch(() => {})
    } catch {
      // A synchronous throw is the same story as a rejection: ignore it.
    }
  }
}
