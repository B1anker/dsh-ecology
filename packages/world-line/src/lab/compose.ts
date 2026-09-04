/**
 * Lab compose validation (Phase 2): static analysis over a real `--dump-config`
 * composed tree plus the lab's patch overlays, and the `compose` probe that
 * drives one dump through an injectable runner.
 *
 * The composed tree is the loader's flat row list, emitted per bundle under
 * `# == <bundle-name>` section comments. The analysis is deliberately
 * structural — ids, names, insert rows, and explicit inject-external markers —
 * and never evaluates `!!js` config (that stays with the loader).
 */

import yaml from 'js-yaml'

import { patchSchema } from '../domain/composition.js'
import { FileError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { redactText } from '../domain/redaction.js'
import { dshDumpArgs } from '../host-adapters/dsh-0.1.x.js'
import type { RunOutcome } from './runner.js'

/** One row of a composed tree, in emission order. */
export interface ComposedRow {
  /** Row id (`id:`), when the loader emitted one. */
  id?: string
  /** Row display name (`name:`). */
  name?: string
  /** Whether the row carries an explicit inject-external marker. */
  injectExternal: boolean
}

export interface ActiveComposition {
  rows: ComposedRow[]
  /** Raw row mappings by id, kept for structural analysis (not serializable). */
  rawById: ReadonlyMap<string, Record<string, unknown>>
}

export type CompositionProblemCode =
  | 'duplicate-id'
  | 'invalid-patch-row'
  | 'inject-external-cycle'
  | 'missing-package'

export interface CompositionProblem {
  code: CompositionProblemCode
  detail: string
  entries: string[]
}

/** Parse composed `--dump-config` YAML text into rows (ids order-preserved). */
export function parseComposedTreeText(text: string, source: string): ActiveComposition {
  let parsed: unknown
  try {
    parsed = yaml.load(text, { schema: patchSchema })
  } catch (error) {
    throw new FileError(`failed to parse composed tree ${source}: ${redactText(String(error))}`)
  }
  if (!Array.isArray(parsed)) {
    throw new FileError(`composed tree ${source} must be a YAML list of loader rows`)
  }
  const rows: ComposedRow[] = []
  const rawById = new Map<string, Record<string, unknown>>()
  for (const item of parsed) {
    collectRows(item, rows, rawById)
  }
  return { rows, rawById }
}

/** Walk one parsed subtree, flattening rows in emission order. */
function collectRows(
  value: unknown,
  rows: ComposedRow[],
  rawById: Map<string, Record<string, unknown>>,
): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, rows, rawById)
    return
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : undefined
  if (id !== undefined) {
    rows.push({
      id,
      name: typeof record.name === 'string' ? record.name : undefined,
      injectExternal: hasInjectExternal(record),
    })
    rawById.set(id, record)
  }
  if (Array.isArray(record.insert)) {
    for (const item of record.insert) collectRows(item, rows, rawById)
  }
}

/** Whether a mapping marks an explicit inject-external service. */
function hasInjectExternal(record: Record<string, unknown>): boolean {
  const inject = record.inject
  if (inject === null || typeof inject !== 'object' || Array.isArray(inject)) return false
  const external = (inject as Record<string, unknown>).external
  return external === true || external === 'true'
}

/**
 * Row ids an external-inject mapping references: inside any `inject` subtree
 * marked external, string leaves that equal an existing row id are edges.
 * Strings elsewhere in a row mapping are never edges.
 */
function injectExternalTargets(
  record: Record<string, unknown>,
  knownIds: ReadonlySet<string>,
): string[] {
  const targets: string[] = []
  const seen = new Set<string>()
  const push = (candidate: unknown): void => {
    if (typeof candidate === 'string' && knownIds.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      targets.push(candidate)
    }
  }
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const map = value as Record<string, unknown>
    const inject = map.inject
    const external =
      inject !== null && typeof inject === 'object' && !Array.isArray(inject)
        ? (inject as Record<string, unknown>).external
        : undefined
    if (external === true || external === 'true') {
      for (const [key, val] of Object.entries(inject as Record<string, unknown>)) {
        if (key === 'external') continue
        if (typeof val === 'string') push(val)
        else visit(val)
      }
      return
    }
    for (const val of Object.values(map)) visit(val)
  }
  visit(record)
  return targets
}

/**
 * Static problems over a composed tree plus (optionally) the overlay patch
 * list that produced it:
 *
 * - duplicate-id: the same id emitted with a name in two or more rows;
 * - invalid-patch-row: a patch entry addresses an id the tree lacks (the host
 *   itself fails these: `patch: entry "x" not found`);
 * - missing-package: an insert row names a provider package that is not
 *   installed in the lab;
 * - inject-external-cycle: an explicit inject-external chain loops.
 */
export function findCompositionProblems(
  composition: ActiveComposition,
  overlayParsed?: unknown[],
  installedNames?: ReadonlySet<string>,
): CompositionProblem[] {
  const problems: CompositionProblem[] = []
  const knownIds = new Set(composition.rawById.keys())

  const byId = new Map<string, string[]>()
  for (const row of composition.rows) {
    if (row.id === undefined || row.name === undefined) continue
    const names = byId.get(row.id) ?? []
    names.push(row.name)
    byId.set(row.id, names)
  }
  for (const [id, names] of byId) {
    if (names.length >= 2) {
      problems.push({
        code: 'duplicate-id',
        detail: `row id ${JSON.stringify(id)} is emitted ${names.length} times with a name`,
        entries: [id],
      })
    }
  }

  if (overlayParsed !== undefined) {
    for (const raw of overlayParsed) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entry = raw as Record<string, unknown>
      const insert = Array.isArray(entry.insert) ? entry.insert : []
      if (typeof entry.id === 'string' && insert.length === 0 && !knownIds.has(entry.id)) {
        problems.push({
          code: 'invalid-patch-row',
          detail: `patch row targets id ${JSON.stringify(entry.id)} which the composed tree does not contain`,
          entries: [entry.id],
        })
      }
      if (installedNames !== undefined) {
        for (const item of insert) {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
          const name = (item as Record<string, unknown>).name
          // Only package-shaped names (@scope/name or name/name with a slash)
          // are checked: bare service ids legitimately exist without a
          // matching installed package (core rows etc.).
          if (typeof name === 'string' && name.includes('/') && !installedNames.has(name)) {
            problems.push({
              code: 'missing-package',
              detail: `insert row names ${JSON.stringify(name)} but no such package is installed in the lab`,
              entries: [name],
            })
          }
        }
      }
    }
  }

  // Explicit inject-external cycles (iterative DFS over raw row mappings).
  const inStack = new Set<string>()
  const done = new Set<string>()
  for (const id of knownIds) {
    if (done.has(id) || inStack.has(id)) continue
    const stack: string[] = [id]
    inStack.add(id)
    while (stack.length > 0) {
      const current = stack[stack.length - 1]
      if (current === undefined) break
      const raw = composition.rawById.get(current)
      let advanced = false
      if (raw !== undefined) {
        for (const target of injectExternalTargets(raw, knownIds)) {
          if (inStack.has(target)) {
            const cycle = [...stack.slice(stack.indexOf(target)), target]
            problems.push({
              code: 'inject-external-cycle',
              detail: `explicit inject-external chain loops: ${cycle.join(' → ')}`,
              entries: cycle,
            })
          } else if (!done.has(target)) {
            stack.push(target)
            inStack.add(target)
            advanced = true
            break
          }
        }
      }
      if (!advanced) {
        stack.pop()
        inStack.delete(current)
        done.add(current)
      }
    }
  }

  return problems
}

// ---------------------------------------------------------------------------
// The compose probe: drives one real dump and records ProbeResults.
// ---------------------------------------------------------------------------

export interface ComposeProbeInput {
  /** The dsh binary to invoke (the lab gate guarantees a known version). */
  dshBinary: string
  /** Profile name inside the lab home. */
  profileName: string
  /** Path of the lab overlay patch (config-apply), or null for none. */
  overlayPath?: string | null
  /** Overlay patch list, parsed — analyzed against the composed tree. */
  overlayParsed?: unknown[]
  /** Installed package names inside the lab profile (missing-package check). */
  installedNames?: ReadonlySet<string>
  /** DSH home env the runner must use (the lab home). */
  env: NodeJS.ProcessEnv
  cwd: string
  /** Injectable runner — runCaptured in production, fakes in tests. */
  run(
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<RunOutcome>
}

export interface ComposeProbeOutcome {
  probes: ProbeResult[]
  problems: CompositionProblem[]
}

const COMPOSE_CHECK = 'compose'

/** Record one compose probe row. */
function composeProbe(
  now: Date,
  label: string,
  status: ProbeResult['status'],
  detail: string,
  entries?: string[],
): ProbeResult {
  return {
    check: COMPOSE_CHECK,
    label,
    required: true,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    status,
    ...(detail !== '' ? { detail } : {}),
    ...(entries !== undefined && entries.length > 0 ? { entries } : {}),
  }
}

/**
 * Run one compose dump probe (required): any spawn error, non-zero exit, or
 * host-side complaint fails the probe; the composed tree is then statically
 * analyzed for duplicate ids, invalid patch rows, missing packages, and
 * explicit inject-external cycles, each recorded as a probe.
 */
export async function runComposeProbe(input: ComposeProbeInput): Promise<ComposeProbeOutcome> {
  const now = new Date()
  const startedAt = now.toISOString()
  const args = dshDumpArgs(input.profileName, input.overlayPath ?? null)

  let outcome: RunOutcome
  try {
    outcome = await input.run(args, { cwd: input.cwd, env: input.env })
  } catch (error) {
    return {
      probes: [
        composeProbe(now, 'compose dump could not be driven', 'fail', redactText(String(error))),
      ],
      problems: [],
    }
  }
  const make = (status: ProbeResult['status'], label: string, detail: string): ProbeResult => ({
    check: COMPOSE_CHECK,
    label,
    required: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    ...(detail !== '' ? { detail } : {}),
  })

  if (outcome.spawnError !== null) {
    return {
      probes: [
        make(
          'fail',
          'compose dump is accepted by the host',
          `dsh could not be spawned: ${redactText(outcome.spawnError)}`,
        ),
      ],
      problems: [],
    }
  }
  const hostComplaint = /patch:\s*entry\s+"[^"]+"\s+not\s+found|error:/i.exec(outcome.stderr)
  if (outcome.exitCode !== 0 || hostComplaint !== null) {
    const detailParts = [`dump exited ${String(outcome.exitCode)}`]
    if (hostComplaint !== null) detailParts.push(redactText(hostComplaint[0]))
    if (outcome.stderr.trim() !== '') detailParts.push(redactText(lastNonEmpty(outcome.stderr)))
    return {
      probes: [make('fail', 'compose dump is accepted by the host', detailParts.join(' — '))],
      problems: [],
    }
  }

  const probesOut: ProbeResult[] = [
    make('pass', 'compose dump is accepted by the host', 'the host accepted the composed tree'),
  ]
  let composition: ActiveComposition
  try {
    composition = parseComposedTreeText(outcome.stdout, 'compose dump')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      probes: [...probesOut, make('fail', 'composed tree parses as loader rows', detail)],
      problems: [],
    }
  }

  const problems = findCompositionProblems(composition, input.overlayParsed, input.installedNames)
  for (const problem of problems) {
    probesOut.push(
      composeProbe(now, problemLabel(problem.code), 'fail', problem.detail, problem.entries),
    )
  }
  if (problems.length === 0) {
    probesOut.push(
      make(
        'pass',
        'static checks find no duplicate ids, invalid rows, missing packages, or inject-external cycles',
        '',
      ),
    )
  }
  return { probes: probesOut, problems }
}

function problemLabel(code: CompositionProblemCode): string {
  switch (code) {
    case 'duplicate-id':
      return 'composed tree emits no duplicate row ids'
    case 'invalid-patch-row':
      return 'patch rows target ids present in the composed tree'
    case 'missing-package':
      return 'insert rows name installed packages'
    case 'inject-external-cycle':
      return 'explicit inject-external chains do not loop'
  }
}

function lastNonEmpty(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines[lines.length - 1] ?? ''
}
