/**
 * Lab manifest (WORLD-LINE-SPEC §5): one JSON document per lab tracking its
 * source (real profile + its receipt), the adapter that vouches for it, the
 * candidate plan of the last run (lab-scoped mutations only), and a state
 * machine that refuses out-of-order operations:
 *
 *   created → applying → passed | failed    (one plan per run)
 *   passed/failed → applying | destroyed    (new plan / cleanup)
 *   destroyed → (terminal; destroy again is refused)
 *
 * Writes are atomic (same discipline as receipts). The manifest never holds
 * URLs, tokens, or anything secret — only the port of a successful host boot
 * and profile-level facts.
 */

import { readFile } from 'node:fs/promises'
import { FileError, InvariantError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { labManifestPath } from './layout.js'

/** Lifecycle states in play order. */
export type LabState = 'created' | 'applying' | 'passed' | 'failed' | 'destroyed'

/** The candidate operations a run may apply — all lab-scoped only. */
export type LabAction = 'add' | 'update' | 'remove' | 'config-apply'

/** One step of a run's plan. */
export interface LabPlanRecord {
  /** 1-based step number. */
  seq: number
  action: LabAction
  /** Target plugin id/spec the step names (add: candidate name; remove/update: the plugin id). */
  id?: string
  /** Version spec for add/update. */
  spec?: string
  /** Materialized config overlay path for config-apply steps. */
  overlayPath?: string
  /** Free-form redacted detail (reason, source). */
  detail?: string
}

export interface LabSource {
  /** The real profile the lab clones from, by name. */
  profileName: string
  /** Adapter-relative profile home (label only; layout derives paths). */
  receipt: string
  /** `profile` (default) or `restore` — provenance marker for journals. */
  kind?: 'profile' | 'restore'
  /** Set when `kind === 'restore'`: the vault snapshot that was materialized. */
  snapshotId?: string
}

export interface LabRuntimeInfo {
  nodeVersion: string
  os: string
  arch: string
}

export interface LabRunInfo {
  startedAt: string
  finishedAt: string
  ok: boolean
  /** Exit code of the lab entry command (0/1/2/3). */
  exitCode: number
  /** HTTP port of the last successful host boot, if any. */
  port?: number
}

export interface LabManifest {
  manifestVersion: 1
  id: string
  createdAt: string
  updatedAt: string
  /** Adapter id vouching for the dsh generation. */
  adapterId: string
  /** Exact exercised dsh version, e.g. `0.1.2-rc.1`. */
  dshVersion: string
  /** Node/OS/arch the lab was created with (spec §5 minimum fields). */
  runtime: LabRuntimeInfo
  source: LabSource
  /** Source profile lockfile hash (spec §5), when the source has one. */
  lockfileHash?: string
  state: LabState
  runCount: number
  lastRun?: LabRunInfo
  plan: LabPlanRecord[]
  retention: {
    /** spec §3: successful labs clean up by default; failures keep 7 days. */
    cleanupMode: 'delete-on-success' | 'keep-on-failure'
    /** ISO instant when a failed lab may be reaped. */
    expiresAt?: string
  }
}

export const LAB_MANIFEST_VERSION = 1 as const

/** Valid state transitions. */
const TRANSITIONS: Record<LabState, readonly LabState[]> = {
  created: ['applying', 'destroyed'],
  applying: ['passed', 'failed'],
  passed: ['applying', 'destroyed'],
  failed: ['applying', 'destroyed'],
  destroyed: [],
}

/**
 * Whether the lab has a run in flight right now (created/passed/failed may
 * all start a new run; applying cannot).
 */
const CURRENTLY_APPLYING = new Set<LabState>(['applying'])

/** Normalize one parsed manifest document (throws on corrupt shapes). */
export function labManifestOf(raw: unknown, id: string): LabManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new FileError(`manifest of lab ${id} is not a JSON object`)
  }
  const value = raw as Record<string, unknown>
  if (value.manifestVersion !== LAB_MANIFEST_VERSION) {
    throw new FileError(
      `manifest of lab ${id} carries unsupported manifestVersion ${String(value.manifestVersion)}`,
    )
  }
  const state = value.state
  if (typeof state !== 'string' || !(state in TRANSITIONS)) {
    throw new FileError(`manifest of lab ${id} carries unknown state ${String(state)}`)
  }
  return value as unknown as LabManifest
}

/** Parse the manifest text of one lab (throws FileError when unreadable). */
export function parseLabManifestText(text: string, id: string): LabManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw new FileError(`manifest of lab ${id} is not valid JSON`)
  }
  return labManifestOf(raw, id)
}

/** Read one lab manifest; throws FileError when missing or corrupt. */
export async function readLabManifest(home: string, id: string): Promise<LabManifest> {
  let text: string
  try {
    text = await readFile(labManifestPath(home, id), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new FileError(
      code === 'ENOENT'
        ? `no manifest for lab ${id} under this home — is it a world-line lab?`
        : `cannot read manifest of lab ${id}: ${String(error)}`,
    )
  }
  return parseLabManifestText(text, id)
}

/** Atomically persist one manifest, bumping updatedAt. */
export async function writeLabManifest(
  home: string,
  manifest: LabManifest,
  now: Date,
): Promise<LabManifest> {
  const updated: LabManifest = { ...manifest, updatedAt: now.toISOString() }
  const text = `${JSON.stringify(updated, null, 2)}\n`
  await writeFileAtomic(labManifestPath(home, updated.id), text)
  return updated
}

/** Transition the state; throws InvariantError on illegal moves. */
export function transitionState(
  manifest: LabManifest,
  to: LabState,
  now: Date,
  detail?: string,
): LabManifest {
  if (!(to in TRANSITIONS)) {
    throw new InvariantError(`unknown lab state ${to}`)
  }
  if (to === manifest.state) {
    throw new InvariantError(
      `lab ${manifest.id} is already ${to}${detail === undefined ? '' : ` (${detail})`}`,
    )
  }
  if (!TRANSITIONS[manifest.state].includes(to)) {
    throw new InvariantError(
      `illegal lab ${manifest.id} transition ${manifest.state} → ${to}${detail === undefined ? '' : ` (${detail})`}`,
    )
  }
  return { ...manifest, state: to, updatedAt: now.toISOString() }
}

/** Whether the lab is mid-run (created/applying) — a run must not start twice. */
export function isApplying(manifest: LabManifest): boolean {
  return CURRENTLY_APPLYING.has(manifest.state)
}
