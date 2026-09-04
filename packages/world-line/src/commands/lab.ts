/**
 * `lab` command implementations (WORLD-LINE-SPEC §3, Phase 2). Every
 * candidate verb runs one full transaction against a fresh isolated lab of
 * the context profile: version gate (fail closed), create (lock + whitelist
 * clone + own home/store), candidate apply, compose/boot/HTTP probes, then
 * §3 retention (success cleans up by default, failures keep 7 days).
 */

import { readFile, stat } from 'node:fs/promises'

import type { CliContext } from '../context.js'
import { parsePatchListText } from '../domain/composition.js'
import { FileError, UsageError } from '../domain/errors.js'
import type { ProbeResult, ProbeSummary } from '../domain/probe.js'
import { summarizeProbes } from '../domain/probe.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { destroyLab, reapExpiredLabs } from '../lab/cleanup.js'
import { createLab } from '../lab/create.js'
import { requireKnownHost } from '../lab/gate.js'
import { labDir, labExists, labProbePath, listLabs } from '../lab/layout.js'
import type { LabManifest, LabPlanRecord } from '../lab/manifest.js'
import { readLabManifest } from '../lab/manifest.js'
import type { CandidateSpec } from '../lab/plans.js'
import { buildPlan, parseCandidateSpec } from '../lab/plans.js'
import type { LabRunOutcome } from '../lab/run.js'
import { runLabTransaction } from '../lab/run.js'

type LabVerb = 'add' | 'update' | 'remove' | 'config-apply'

/** Shared transaction options the CLI surface exposes. */
export interface LabVerbOptions {
  /** Keep a successful lab (default: clean up on success). */
  keep?: boolean
  /** Explicitly allow package build scripts (default --ignore-scripts). */
  allowScripts?: boolean
}

export interface LabActionResult {
  profileName: string
  labId: string | null
  action: LabPlanRecord['action']
  spec: string | undefined
  ok: boolean
  deleted: boolean
  kept: boolean
  probeSummary: ProbeSummary
  port: number | undefined
  /** Retained failed labs carry their 7-day expiry. */
  expiresAt: string | undefined
  dshVersion: string
}

export interface LabListEntry {
  id: string
  profileName: string
  state: LabManifest['state']
  runCount: number
  createdAt: string
  lastOk: boolean | null
  port: number | undefined
  expiresAt: string | undefined
}

export interface LabListResult {
  labs: LabListEntry[]
  reaped: string[]
  profileName: string
}

export interface LabInspectResult {
  manifest: LabManifest
  probes: ProbeResult[]
}

export interface LabDestroyResult {
  id: string
  removed: boolean
}

/** Version gate shared by every mutating verb (fail closed). */
function requireHost(ctx: CliContext) {
  return requireKnownHost(ctx)
}

async function runVerb(
  ctx: CliContext,
  options: LabVerbOptions,
  verb: LabVerb,
  spec: CandidateSpec | undefined,
  specText: string | undefined,
  overlayText: string | undefined,
): Promise<LabActionResult> {
  const host = requireHost(ctx)
  const created = await createLab(ctx, host, ctx.profileName)
  const labId = created.manifest.id
  let overlayPath: string | undefined
  if (overlayText !== undefined) {
    overlayPath = `${labDir(ctx.home, labId)}/config-apply.yml`
    await writeFileAtomic(overlayPath, overlayText)
  }
  const plan = buildPlan({
    action: verb,
    spec,
    overlayPath,
  })
  const outcome: LabRunOutcome = await runLabTransaction({
    ctx,
    host,
    labId,
    plan,
    allowScripts: options.allowScripts,
    keep: options.keep,
  })
  const summary = summarizeProbes(outcome.probes)
  const kept = !outcome.deleted
  let expiresAt: string | undefined
  if (!outcome.ok && kept) {
    const manifest = await readLabManifest(ctx.home, labId).catch(() => null)
    expiresAt = manifest?.retention.expiresAt
  }
  return {
    profileName: ctx.profileName,
    labId: outcome.deleted ? null : labId,
    action: (plan[0]?.action ?? 'config-apply') as LabPlanRecord['action'],
    spec: specText,
    ok: outcome.ok,
    deleted: outcome.deleted,
    kept,
    probeSummary: summary,
    port: outcome.port,
    expiresAt,
    dshVersion: host.raw,
  }
}

/** `lab add <spec>`: install a candidate into a fresh lab and verify. */
export async function runLabAdd(
  ctx: CliContext,
  specRaw: string,
  options: LabVerbOptions,
): Promise<LabActionResult> {
  const spec = parseCandidateSpec(specRaw, ctx.cwd)
  return await runVerb(ctx, options, 'add', spec, specRaw, undefined)
}

/** `lab update <package>`: replace the package's version in a fresh lab. */
export async function runLabUpdate(
  ctx: CliContext,
  specRaw: string,
  options: LabVerbOptions,
): Promise<LabActionResult> {
  const spec = parseCandidateSpec(specRaw, ctx.cwd)
  return await runVerb(ctx, options, 'update', spec, specRaw, undefined)
}

/** `lab remove <package>`: remove a package inside a fresh lab. */
export async function runLabRemove(
  ctx: CliContext,
  packageName: string,
  options: LabVerbOptions,
): Promise<LabActionResult> {
  const spec = parseCandidateSpec(packageName, ctx.cwd)
  if (spec.localPath !== undefined || spec.version !== undefined) {
    throw new UsageError(`lab remove takes a bare package name, got ${JSON.stringify(packageName)}`)
  }
  return await runVerb(ctx, options, 'remove', spec, packageName, undefined)
}

/** `lab config apply <patch.yml>`: overlay a config patch in a fresh lab. */
export async function runLabConfigApply(
  ctx: CliContext,
  patchFile: string,
  options: LabVerbOptions,
): Promise<LabActionResult> {
  let text: string
  try {
    text = await readFile(patchFile, 'utf8')
  } catch (error) {
    throw new FileError(`cannot read config patch ${patchFile}: ${String(error)}`)
  }
  // Fail fast on dialect errors before any lab work happens.
  parsePatchListText(text, patchFile)

  return await runVerb(ctx, options, 'config-apply', undefined, patchFile, text)
}

/** `lab list`: retained labs, newest first; expired failures are reaped. */
export async function runLabList(ctx: CliContext): Promise<LabListResult> {
  const now = ctx.now()
  const reaped = (await reapExpiredLabs(ctx.home, now)).reaped
  const ids = await listLabs(ctx.home)
  const labs: LabListEntry[] = []
  for (const id of ids) {
    let manifest: LabManifest
    try {
      manifest = await readLabManifest(ctx.home, id)
    } catch {
      continue // corrupt/no manifest: invisible to list, destroy can remove it
    }
    labs.push({
      id,
      profileName: manifest.source.profileName,
      state: manifest.state,
      runCount: manifest.runCount,
      createdAt: manifest.createdAt,
      lastOk: manifest.lastRun?.ok ?? null,
      port: manifest.lastRun?.port,
      expiresAt: manifest.retention.expiresAt,
    })
  }
  return { labs, reaped, profileName: ctx.profileName }
}

/** `lab inspect <id>`: manifest plus the last run's probe records. */
export async function runLabInspect(ctx: CliContext, labId: string): Promise<LabInspectResult> {
  const manifest = await readLabManifest(ctx.home, labId)
  let probes: ProbeResult[] = []
  try {
    const info = await stat(labProbePath(ctx.home, labId))
    if (info.isFile()) {
      const raw = JSON.parse(await readFile(labProbePath(ctx.home, labId), 'utf8')) as {
        probes?: ProbeResult[]
      }
      probes = raw.probes ?? []
    }
  } catch {
    probes = []
  }
  return { manifest, probes }
}

/** `lab destroy <id>`: remove one lab (refuses mid-run labs). */
export async function runLabDestroy(ctx: CliContext, labId: string): Promise<LabDestroyResult> {
  if (!labId.startsWith('lab-')) {
    throw new UsageError(`malformed lab id ${JSON.stringify(labId)}`)
  }
  if (!(await labExists(ctx.home, labId))) {
    throw new UsageError(`no such lab ${labId} under this home`)
  }
  return await destroyLab(ctx.home, labId)
}

/** Render one lab list row (shared by list/inspect human output). */
export function renderLabVerb(result: LabActionResult): string {
  const lines = [
    `lab ${result.action}${result.spec !== undefined ? ` ${result.spec}` : ''}`,
    `profile   ${result.profileName}`,
    `dsh       ${result.dshVersion} (lab gate: exact known version)`,
    `probes    ${result.probeSummary.passed} passed, ${result.probeSummary.failed} failed, ` +
      `${result.probeSummary.warned} warned, ${result.probeSummary.skipped} skipped`,
    `verdict   ${result.ok ? 'PASS' : 'FAIL'}${result.port !== undefined ? ` (host ready on loopback port ${result.port})` : ''}`,
  ]
  if (result.deleted) {
    lines.push('cleanup   deleted (default: successful labs clean up; use --keep to retain)')
  } else if (result.labId !== null) {
    lines.push(
      `lab       ${result.labId} retained${result.expiresAt !== undefined ? ` until ${result.expiresAt}` : ''}`,
    )
  }
  return `${lines.join('\n')}\n`
}
