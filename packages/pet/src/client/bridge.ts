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
 * `companionEnabled` setting is off (the default).
 *
 * @module @seaveyon/dsh-pet/client/bridge
 */

import type { Mood, PetStateMachine } from './mood.js'
import type { PetSettingsStore } from './settings.js'

/**
 * Contract with the desktop app: it serves `POST /state` on this loopback
 * port, accepting a JSON {@link DesktopBridgeState} body. The port is fixed
 * on both sides; changing it here without changing the app breaks the pair.
 */
export const DESKTOP_COMPANION_PORT = 45731

export const DEFAULT_ENDPOINT = `http://127.0.0.1:${DESKTOP_COMPANION_PORT}/state`

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
