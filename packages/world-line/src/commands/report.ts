/**
 * `dsh-world-line report <lab-id|snapshot-id>` (WORLD-LINE-SPEC §3, Phase 4):
 * one redacted diagnostics bundle per target, written to
 * `world-line/reports/<report-id>.json` (never to stdout in full).
 *
 * The bundle is diagnostic, not authoritative: it collects the immutable
 * manifest (lab or snapshot), probe records, and — for labs — the tail of
 * the boot/browser logs. Everything is redacted before it is written
 * (invariant 6); log tails are the only source that was not already
 * redacted at capture time, so they pass through `redactText`.
 *
 * Corruption is recorded inside the bundle, not fatal: a report must work
 * on the broken states a user is about to diagnose. Only an unknown or
 * malformed id is a usage error.
 */

import { randomBytes } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from '../context.js'
import { runtimeEnvironment } from '../context.js'
import { UsageError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { redactText } from '../domain/redaction.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { reportPath, snapshotManifestPath } from '../fs/paths.js'
import { WORLD_LINE_VERSION } from '../identity.js'
import {
  assertValidLabId,
  labDir,
  labExists,
  labLogDir,
  labProbePath,
  labProfileDir,
} from '../lab/layout.js'
import { parseLabManifestText } from '../lab/manifest.js'
import { assertSnapshotId, readSnapshotManifest } from '../vault/manifests.js'

/** One section of a report bundle (redacted text or structured facts). */
export interface ReportSection {
  title: string
  /** Redacted free text (log tails, parse errors). */
  text?: string
  /** Structured facts already free of secret values at the source. */
  facts?: unknown
}

/** The diagnostics bundle for one target. */
export interface ReportResult {
  reportId: string
  path: string
  createdAt: string
  target: { kind: 'lab' | 'snapshot'; id: string; profileName: string | null }
  sections: ReportSection[]
  notes: string[]
}

const LOG_TAIL_LINES = 200
const LOG_TAIL_MAX_CHARS = 6000

/** A new report id (`report-…`), stable with the journal id style. */
export function newReportId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `report-${stamp}-${randomBytes(4).toString('hex')}`
}

async function readTail(file: string, lines: number): Promise<string | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return `(unreadable: ${redactText(String(error))})`
  }
  const tail = text.split('\n').slice(-lines).join('\n')
  return tail.length > LOG_TAIL_MAX_CHARS ? tail.slice(-LOG_TAIL_MAX_CHARS) : tail
}

async function collectLabSections(
  home: string,
  labId: string,
  notes: string[],
): Promise<{ profileName: string | null; sections: ReportSection[] }> {
  const sections: ReportSection[] = []
  let profileName: string | null = null

  try {
    const text = await readFile(join(labDir(home, labId), 'manifest.json'), 'utf8')
    const manifest = parseLabManifestText(text, labId)
    profileName = manifest.source.profileName
    sections.push({
      title: 'lab manifest',
      facts: {
        id: manifest.id,
        state: manifest.state,
        dsh: { adapterId: manifest.adapterId, version: manifest.dshVersion },
        runtime: manifest.runtime,
        source: manifest.source,
        plan: manifest.plan,
        retention: manifest.retention,
        lastRun: manifest.lastRun,
      },
    })
  } catch (error) {
    notes.push(`manifest of lab ${labId} is missing or corrupt: ${redactText(String(error))}`)
  }

  try {
    const raw = await readFile(labProbePath(home, labId), 'utf8')
    const parsed = JSON.parse(raw) as { probes?: ProbeResult[] }
    const probes = parsed.probes ?? []
    sections.push({
      title: 'probes',
      facts: probes.map((entry) => ({
        check: entry.check,
        status: entry.status,
        required: entry.required,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        detail: entry.detail,
        entries: entry.entries,
      })),
    })
  } catch (error) {
    notes.push(`probe records unreadable for lab ${labId}: ${redactText(String(error))}`)
  }

  for (const name of ['dsh.log', 'browser.log']) {
    const tail = await readTail(join(labLogDir(home, labId), name), LOG_TAIL_LINES)
    if (tail === null) continue
    sections.push({ title: `log tail: ${name}`, text: redactText(tail) })
  }

  if (profileName !== null) {
    try {
      const present = (await readdir(labProfileDir(home, labId, profileName))).filter((name) =>
        ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'].includes(
          name,
        ),
      )
      if (present.length > 0) sections.push({ title: 'profile files present', facts: present })
    } catch {
      // A missing profile dir is a fact for the human, not a report error.
    }
  }
  return { profileName, sections }
}

/** Run `report <lab-id | snapshot-id>`; writes only inside the reports dir. */
export async function runReport(ctx: CliContext, target: string): Promise<ReportResult> {
  const now = ctx.now()
  const reportId = newReportId(now)
  const notes: string[] = []
  const sections: ReportSection[] = []

  let kind: 'lab' | 'snapshot'
  let id: string
  let profileName: string | null = null

  if (target.startsWith('lab-')) {
    kind = 'lab'
    id = target
    assertValidLabId(id)
    if (!(await labExists(ctx.home, id))) {
      throw new UsageError(`no such lab ${id} under this home`)
    }
    const collected = await collectLabSections(ctx.home, id, notes)
    profileName = collected.profileName
    sections.push(...collected.sections)
  } else if (target.startsWith('snap-')) {
    kind = 'snapshot'
    id = target
    assertSnapshotId(id)
    try {
      await stat(snapshotManifestPath(ctx.home, id))
    } catch {
      throw new UsageError(`no snapshot ${id} in the vault under this home`)
    }
    try {
      const manifest = await readSnapshotManifest(ctx.home, id)
      profileName = manifest.profile.name
      sections.push({
        title: 'snapshot manifest',
        facts: {
          id: manifest.id,
          createdAt: manifest.createdAt,
          label: manifest.label,
          parentId: manifest.parentId,
          action: manifest.action,
          dsh: manifest.dsh,
          profile: {
            name: manifest.profile.name,
            receipt: manifest.profile.receipt,
            manifest: manifest.profile.manifest,
          },
          files: manifest.files.map((file) => ({
            name: file.name,
            role: file.role,
            size: file.size,
            stored: file.object !== null,
            secretSkipped: file.secretSkipped,
            sha256: file.sha256,
          })),
          unmanaged: manifest.unmanaged,
          derived: manifest.derived,
        },
      })
    } catch (error) {
      notes.push(`snapshot ${id} is not in this vault or is corrupt: ${redactText(String(error))}`)
    }
  } else {
    throw new UsageError('report target must be a lab id (lab-…) or a snapshot id (snap-…)')
  }

  const result: ReportResult = {
    reportId,
    path: reportPath(ctx.home, reportId),
    createdAt: now.toISOString(),
    target: { kind, id, profileName },
    sections,
    notes,
  }
  const bundle = {
    formatVersion: 1,
    report: {
      id: reportId,
      createdAt: result.createdAt,
      worldLineVersion: WORLD_LINE_VERSION,
      environment: runtimeEnvironment(),
      target: result.target,
    },
    notes,
    sections,
    redacted: true,
  }
  await writeFileAtomic(result.path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
  return result
}
