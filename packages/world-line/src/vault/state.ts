/**
 * world-line store state (`world-line/state.json`).
 *
 * Bookkeeping only — timeline truth lives in the immutable snapshot
 * manifests; the state file carries creation/update stamps and the latest
 * snapshot id per profile so tooling can answer "what changed since my last
 * snapshot?" without scanning the vault.
 */

import { readFile } from 'node:fs/promises'
import { InvariantError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { statePath } from '../fs/paths.js'
import { WORLD_LINE_FORMAT_VERSION } from '../identity.js'

/** The persisted store state. */
export interface StoreState {
  formatVersion: number
  createdAt: string | null
  updatedAt: string | null
  /** Profile name → latest snapshot id in this store. */
  lastSnapshots: Record<string, string>
  /** Profile name → lastKnownGood snapshot id (Phase 3, restart verification). */
  lastKnownGood: Record<string, string>
}

/** A fresh state for a store that has never been written. */
export function emptyState(): StoreState {
  return {
    formatVersion: WORLD_LINE_FORMAT_VERSION,
    createdAt: null,
    updatedAt: null,
    lastSnapshots: {},
    lastKnownGood: {},
  }
}

/** Read the store state; a missing file yields a fresh state. */
export async function readState(home: string): Promise<StoreState> {
  let raw: string
  try {
    raw = await readFile(statePath(home), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw new InvariantError(`failed to read store state ${statePath(home)}`)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreState>
    if (parsed.formatVersion === undefined) return emptyState()
    if (parsed.formatVersion > WORLD_LINE_FORMAT_VERSION) {
      throw new InvariantError(
        `store state ${statePath(home)} was written by a newer world-line ` +
          `(format ${parsed.formatVersion} > ${WORLD_LINE_FORMAT_VERSION})`,
      )
    }
    return {
      formatVersion: WORLD_LINE_FORMAT_VERSION,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      lastSnapshots:
        parsed.lastSnapshots !== null && typeof parsed.lastSnapshots === 'object'
          ? (parsed.lastSnapshots as Record<string, string>)
          : {},
      lastKnownGood:
        parsed.lastKnownGood !== null && typeof parsed.lastKnownGood === 'object'
          ? (parsed.lastKnownGood as Record<string, string>)
          : {},
    }
  } catch (error) {
    if (error instanceof InvariantError) throw error
    throw new InvariantError(`store state ${statePath(home)} is corrupt: ${String(error)}`)
  }
}

/** Persist the store state. */
export async function writeState(home: string, state: StoreState): Promise<void> {
  const now = new Date().toISOString()
  const next: StoreState = {
    ...state,
    updatedAt: now,
    createdAt: state.createdAt ?? now,
  }
  const raw = `${JSON.stringify(next, null, 2)}\n`
  await writeFileAtomic(statePath(home), raw, { mode: 0o600 })
}

/** Record one snapshot as the latest for its profile and persist. */
export async function noteSnapshot(home: string, profileName: string, id: string): Promise<void> {
  const state = await readState(home)
  state.lastSnapshots[profileName] = id
  await writeState(home, state)
}

/** Mark one snapshot as the profile's lastKnownGood and persist. */
export async function noteLastKnownGood(
  home: string,
  profileName: string,
  id: string,
): Promise<void> {
  const state = await readState(home)
  state.lastKnownGood[profileName] = id
  await writeState(home, state)
}

/** Read the profile's lastKnownGood snapshot id, if any. */
export async function lastKnownGoodFor(home: string, profileName: string): Promise<string | null> {
  const state = await readState(home)
  return state.lastKnownGood[profileName] ?? null
}
