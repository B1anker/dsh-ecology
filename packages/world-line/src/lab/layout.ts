/**
 * Lab layout (WORLD-LINE-SPEC §5): one lab lives at
 * `<DSH_HOME>/world-line/labs/<lab-id>/` with
 *
 *   home/          — a full DSH home the host boots with DSH_HOME=…
 *                    (profiles/<name> inside it holds the clone)
 *   pnpm-store/    — the lab-scoped package-manager store
 *   logs/          — dsh boot transcripts
 *   manifest.json  — the §5 lab manifest
 *   probe.json     — full ProbeResult list of the last run
 *
 * Nothing here ever writes outside `<home>/world-line/labs`, so no real
 * profile or host state can be reached by layout mistakes.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { UsageError } from '../domain/errors.js'
import { worldLineDir } from '../fs/paths.js'

/** Lab id shape: `lab-YYYYMMDDTHHMMSSZ-<8 lowercase hex>` (mirrors snapshot ids). */
export const LAB_ID_RE = /^lab-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/

/** Root of all labs for one DSH home. */
export function labRoot(home: string): string {
  return join(worldLineDir(home), 'labs')
}

/** New lab id for a creation instant (lexicographically ordered). */
export function newLabId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0')
  return `lab-${stamp}-${rand}`
}

/** Throw UsageError when `id` is not a well-formed lab id. */
export function assertValidLabId(id: string): void {
  if (!LAB_ID_RE.test(id)) {
    throw new UsageError(
      `malformed lab id ${JSON.stringify(id)} (expected lab-YYYYMMDDTHHMMSSZ-xxxxxxxx)`,
    )
  }
}

/** Directory of one lab. */
export function labDir(home: string, id: string): string {
  assertValidLabId(id)
  return join(labRoot(home), id)
}

/** The lab's own DSH home (boot env DSH_HOME points here). */
export function labHomeDir(home: string, id: string): string {
  return join(labDir(home, id), 'home')
}

/** The cloned profile directory inside the lab home. */
export function labProfileDir(home: string, id: string, profileName: string): string {
  return join(labHomeDir(home, id), 'profiles', profileName)
}

/** The lab-scoped pnpm store. */
export function labStoreDir(home: string, id: string): string {
  return join(labDir(home, id), 'pnpm-store')
}

/** Boot/plugin transcripts for one lab. */
export function labLogDir(home: string, id: string): string {
  return join(labDir(home, id), 'logs')
}

/** The §5 lab manifest path. */
export function labManifestPath(home: string, id: string): string {
  return join(labDir(home, id), 'manifest.json')
}

/** The last run's full probe list path. */
export function labProbePath(home: string, id: string): string {
  return join(labDir(home, id), 'probe.json')
}

/** List lab ids in one home, newest first; absent labs root ⇒ []. */
export async function listLabs(home: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(labRoot(home))
  } catch {
    return []
  }
  return names
    .filter((name) => LAB_ID_RE.test(name))
    .sort()
    .reverse()
}

/** Whether one lab directory exists. */
export async function labExists(home: string, id: string): Promise<boolean> {
  try {
    const info = await stat(labDir(home, id))
    return info.isDirectory()
  } catch {
    return false
  }
}
