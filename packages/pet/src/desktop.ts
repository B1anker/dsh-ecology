/**
 * Desktop-bridge contract: the pure mood types and constants shared with the
 * pet-desktop Zig app (packages/pet-desktop) and the sprite-baking pipeline.
 *
 * The desktop app keeps its own hand-mirrored Zig enum (its src/state.zig
 * carries the same values in the same order); this entry is the source of
 * truth on the TypeScript side, so baking scripts and generated Zig code can
 * import one module instead of scraping the state machine.
 *
 * The mood import is type-only on purpose: the host entry builds with
 * `bundle: false`, which emits entry files only, so a runtime re-export of
 * client/mood.js would dangle. The pulse durations stay with the state
 * machine — the desktop app receives finished moods, never pulses.
 *
 * @module @seaveyon/dsh-pet/desktop
 */

import type { Mood } from './client/mood.js'

export type { Mood }

/** Every mood value, in the same order as pet-desktop's Zig `Mood` enum. */
export const MOODS = [
  'idle',
  'thinking',
  'working',
  'waiting',
  'sad',
  'sleeping',
  'celebrating',
  'pet',
] as const satisfies readonly Mood[]

/** Compile-time guard: MOODS must cover every Mood the union declares. */
export type MoodCoverageCheck = Exclude<Mood, (typeof MOODS)[number]> extends never ? true : never

/** The desktop app's loopback state server: POST /state with {mood, petId, name}. */
export const DESKTOP_BRIDGE_PORT = 45731

/** The full /state URL the plugin's desktop bridge POSTs mood updates to. */
export const DESKTOP_BRIDGE_STATE_URL = `http://127.0.0.1:${DESKTOP_BRIDGE_PORT}/state`
