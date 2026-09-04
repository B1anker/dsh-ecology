/**
 * Rescue command (WORLD-LINE-SPEC §3 diagnostic & rescue, Phase 4): boot a
 * temporary safe profile under `world-line/rescues/<id>/home` that loads
 * exactly the version-policy core bundle layer plus the user's explicit
 * `--allow` row ids from the official `cordis.patch.yml` (verbatim block
 * copy — never rewritten, reordered, or disabled in place). The official
 * profile and its patch are only read (under the writer lock) and stay
 * byte-identical. `rescue stop` terminates the recorded process group and
 * removes the rescue home.
 *
 * Pass bar: host boot + HTTP ready. The browser client probe is diagnostic
 * only (a rescue exists for environments that may be broken; no promotion
 * decision is ever made here), see docs/phase4-design.md §2.2.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { dshBootArgs } from '../host-adapters/dsh-0.1.x.js'
import { requireKnownHost } from '../lab/gate.js'
import { launchDsh } from '../lab/launcher.js'

/** Rescue id: `rescue-YYYYMMDDTHHMMSSZ-<8 hex>` (mirrors lab/snapshot ids). */
export const RESCUE_ID_RE = /^rescue-\d{8}T\d{6}Z-[0-9a-f]{8}$/

export interface RescueRecord {
  formatVersion: 1
  kind: 'rescue'
  id: string
  createdAt: string
  updatedAt: string
  profileName: string
  state: 'running' | 'stopped' | 'failed'
  pid: number | null
  port: number | null
  hostVersion: string
  note?: string
}

export interface RescueStartResult {
  ok: boolean
  id: string
  state: 'running' | 'failed'
  pid: number | null
  port: number | null
  profileName: string
  hostVersion: string
  /** Human note (already redacted). */
  note?: string
}

export interface RescueListItem {
  id: string
  profileName: string
  state: RescueRecord['state']
  pid: number | null
  port: number | null
  alive: boolean
  note?: string
}

export interface RescueStopResult {
  id: string
  pid: number | null
  removed: boolean
}

const RESCUE_FORMAT_VERSION = 1

export function newRescueId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  return `rescue-${stamp}-${randomBytes(4).toString('hex')}`
}

export function rescuesDir(home: string): string {
  return join(home, 'world-line', 'rescues')
}

export function rescueDir(home: string, id: string): string {
  return join(rescuesDir(home), id)
}

export function rescueHomeDir(home: string, id: string): string {
  return join(rescueDir(home, id), 'home')
}

export function rescueLogDir(home: string, id: string): string {
  return join(rescueDir(home, id), 'logs')
}

function rescueRecordPath(home: string, id: string): string {
  return join(rescueDir(home, id), 'rescue.json')
}

function rescueProbePath(home: string, id: string): string {
  return join(rescueDir(home, id), 'probe.json')
}

function pidAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

/**
 * Keep only the `--allow`ed entry blocks of the official patch, byte-for-byte
 * (a top-level `- id:` starts a block; trailing block-style scalars stay in
 * it). Disabled rows are dropped with their ids reported; rows the user did
 * not name are dropped silently — rescue is core-only by default.
 */
export function filterPatchBlocks(
  text: string,
  allowed: string[],
): { patch: string; disabled: string[]; found: string[] } {
  const blocks: string[][] = []
  let current: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    if (/^-\s+id:\s*/.test(line)) {
      current = []
      blocks.push(current)
    }
    if (current !== null) current.push(line)
  }
  const idOf = (block: string[]): string | null => {
    const match = /^-\s+id:\s*['"]?([^'"]+)['"]?\s*$/.exec(block[0] ?? '')
    return match === null || match[1] === undefined ? null : match[1]
  }
  const disabledOf = (block: string[]): boolean =>
    block.some((line) => /disabled:\s*true/.test(line))
  const allowedSet = new Set(allowed)
  const kept: string[] = []
  const disabled: string[] = []
  const found: string[] = []
  for (const block of blocks) {
    const id = idOf(block)
    if (id === null || !allowedSet.has(id)) continue
    if (disabledOf(block)) {
      disabled.push(id)
      continue
    }
    found.push(id)
    kept.push(...block)
  }
  const patch = kept.length === 0 ? '[]\n' : `${kept.join('\n')}\n`
  return { patch, disabled, found }
}

async function readOfficialPatch(ctx: CliContext): Promise<string> {
  try {
    return await readFile(join(profileDir(ctx.home, ctx.profileName), 'cordis.patch.yml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]\n'
    throw error
  }
}

async function stopGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Group already gone; the directory removal below is the real cleanup.
  }
  await new Promise((resolve) => setTimeout(resolve, 1600))
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Best-effort final kill.
  }
}

/** Boot the rescue profile and persist its record + probes on success. */
export async function runRescueStart(ctx: CliContext, allow: string[]): Promise<RescueStartResult> {
  const host = requireKnownHost(ctx)
  const id = newRescueId(ctx.now())
  const startedAt = ctx.now().toISOString()

  const patchText = await readOfficialPatch(ctx)
  const filtered = filterPatchBlocks(patchText, allow)
  const unknown = allow.filter(
    (name) => !filtered.found.includes(name) && !filtered.disabled.includes(name),
  )
  if (unknown.length > 0) {
    throw new UsageError(
      `rescue --allow: no patch row named ${JSON.stringify(unknown.join(', '))} in the ` +
        `official cordis.patch.yml (available row ids are copied into rescue only when named)`,
    )
  }
  // The official patch must not change under a concurrent writer while we
  // read it; release before the (long) boot — the boot touches only the
  // rescue home.
  const lock = await acquireLock({
    lockPath: profileLockPath(ctx.home, ctx.profileName),
    purpose: `rescue start (read ${ctx.profileName} patch)`,
    breakStale: ctx.breakStaleLock,
    now: ctx.now(),
  })
  await lock.release()

  const base = rescueDir(ctx.home, id)
  const home = rescueHomeDir(ctx.home, id)
  const profileName = ctx.profileName
  await mkdir(join(home, 'profiles', profileName), { recursive: true })
  await mkdir(rescueLogDir(ctx.home, id), { recursive: true })
  await writeFileAtomic(join(home, 'profiles', profileName, 'cordis.patch.yml'), filtered.patch, {
    mode: 0o600,
  })

  const launch = await launchDsh({
    dshBinary: host.binary.path,
    args: dshBootArgs(profileName, 0),
    cwd: home,
    env: { ...ctx.env, DSH_HOME: home, WORLD_LINE_RESCUE: id },
    keepAlive: true,
  })
  if (launch.kind !== 'ready' || launch.handle === undefined) {
    const detail = launch.detail
    await rm(base, { recursive: true, force: true })
    return {
      ok: false,
      id,
      state: 'failed',
      pid: null,
      port: null,
      profileName,
      hostVersion: host.raw,
      note: `rescue boot failed: ${detail}`,
    }
  }

  // HTTP ready probe: the booted server must answer on its own port.
  let httpProbe = 'pass'
  let httpDetail = `HTTP response on 127.0.0.1:${launch.handle.port}`
  try {
    const response = await fetch(`http://127.0.0.1:${launch.handle.port}/`, {
      signal: AbortSignal.timeout(10_000),
    })
    // The root path without the per-boot token may 404 by design; any
    // server answer proves the socket accepts connections.
    if (response.status >= 500) {
      httpProbe = 'fail'
      httpDetail = `HTTP ${response.status} on the root path`
    }
  } catch {
    httpProbe = 'fail'
    httpDetail = 'no HTTP response from the booted server'
  }
  const finishedAt = ctx.now().toISOString()
  const probes = [
    {
      check: 'host-boot',
      label: 'rescue host boot',
      required: true,
      startedAt,
      finishedAt,
      status: 'pass',
      detail: `dsh ${host.raw} ready on 127.0.0.1:${launch.handle.port}`,
    },
    {
      check: 'http-ready',
      label: 'HTTP ready',
      required: httpProbe === 'pass',
      startedAt,
      finishedAt,
      status: httpProbe,
      ...(httpProbe === 'pass' ? {} : { detail: httpDetail }),
    },
  ]
  await writeFileAtomic(rescueProbePath(ctx.home, id), `${JSON.stringify({ probes }, null, 2)}\n`, {
    mode: 0o600,
  })
  const record: RescueRecord = {
    formatVersion: RESCUE_FORMAT_VERSION,
    kind: 'rescue',
    id,
    createdAt: startedAt,
    updatedAt: finishedAt,
    profileName,
    state: 'running',
    pid: launch.handle.pid,
    port: launch.handle.port,
    hostVersion: host.raw,
    ...(httpProbe === 'fail' ? { note: 'HTTP probe failed on a ready boot' } : {}),
  }
  await writeFileAtomic(rescueRecordPath(ctx.home, id), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  })
  return {
    ok: httpProbe === 'pass',
    id,
    state: 'running',
    pid: launch.handle.pid,
    port: launch.handle.port,
    profileName,
    hostVersion: host.raw,
    ...(httpProbe === 'fail' ? { note: 'booted but the HTTP probe failed' } : {}),
  }
}

async function readRescueRecord(home: string, id: string): Promise<RescueRecord> {
  let text: string
  try {
    text = await readFile(rescueRecordPath(home, id), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new UsageError(
      code === 'ENOENT'
        ? `no rescue ${id} under this home`
        : `cannot read record of rescue ${id}: ${String(error)}`,
    )
  }
  const record = JSON.parse(text) as RescueRecord
  if (record.kind !== 'rescue' || record.id !== id) {
    throw new UsageError(`record at rescue ${id} is not a world-line rescue record`)
  }
  return record
}

/** List every rescue directory with a record; dead pids are flagged stale. */
export async function runRescueList(ctx: CliContext): Promise<{ rescues: RescueListItem[] }> {
  const entries = await readdir(rescuesDir(ctx.home)).catch(() => [])
  const rescues: RescueListItem[] = []
  for (const name of entries) {
    if (!RESCUE_ID_RE.test(name)) continue
    try {
      const record = await readRescueRecord(ctx.home, name)
      const alive = record.state === 'running' && pidAlive(record.pid)
      rescues.push({
        id: name,
        profileName: record.profileName,
        state: record.state,
        pid: record.pid,
        port: record.port,
        alive,
        ...(record.note !== undefined ? { note: record.note } : {}),
      })
    } catch {
      // Skip directories without a readable record (half-created).
    }
  }
  rescues.sort((a, b) => a.id.localeCompare(b.id))
  return { rescues }
}

/** Stop one rescue: terminate its process group, then remove its directory. */
export async function runRescueStop(ctx: CliContext, id: string): Promise<RescueStopResult> {
  if (!RESCUE_ID_RE.test(id)) throw new UsageError(`malformed rescue id ${JSON.stringify(id)}`)
  const record = await readRescueRecord(ctx.home, id)
  const pid = record.pid
  if (pid !== null && pid > 0 && record.state === 'running') {
    await stopGroup(pid)
  }
  await rm(rescueDir(ctx.home, id), { recursive: true, force: true })
  return { id, pid, removed: true }
}

/** True when a rescue record exists for `id` (used by tests). */
export async function rescueExists(home: string, id: string): Promise<boolean> {
  try {
    await readRescueRecord(home, id)
    return true
  } catch {
    return false
  }
}
