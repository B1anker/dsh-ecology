/**
 * Lab candidate plans (WORLD-LINE-SPEC §3/§6, Phase 2): translate one CLI
 * candidate verb into the run's plan records. Every mutation targets the lab
 * copy only — the plan is executed by `run.ts` against `labs/<id>/home`
 * (DSH_HOME) and `labs/<id>/profile`, never against the real profile.
 *
 * Offline-friendly rules: a `file:`/absolute-path spec is a local plugin
 * (pnpm resolves it offline); a bare or `@version` spec is a registry package
 * (needs the registry — surfaced as a warn when the lab pnpm store is empty).
 */

import { isAbsolute, resolve } from 'node:path'

import { UsageError } from '../domain/errors.js'
import type { LabAction, LabPlanRecord } from './manifest.js'

/** One parsed candidate spec. */
export interface CandidateSpec {
  /** Package name (the plan's target id). */
  name: string
  /** Version range when the spec carried one. */
  version?: string
  /** Absolute local plugin path when the spec is a `file:`/`link:`/path spec. */
  localPath?: string
}

/** Parse `name@version`, `@scope/name@version`, or a `file:`/`link:` local spec. */
export function parseCandidateSpec(raw: string, cwd: string = process.cwd()): CandidateSpec {
  const trimmed = raw.trim()
  if (trimmed === '') throw new UsageError('candidate spec is empty')

  const fileMatch = /^(?:file|link):(.+)$/.exec(trimmed)
  if (fileMatch?.[1] !== undefined) {
    const target = fileMatch[1]
    if (target === '')
      throw new UsageError(`candidate ${JSON.stringify(raw)} has an empty file: target`)
    const absolute = isAbsolute(target) ? target : resolve(cwd, target)
    return { name: basenameOf(absolute), localPath: absolute }
  }
  if (/^\.{0,2}\//.test(trimmed)) {
    throw new UsageError(
      `candidate ${JSON.stringify(trimmed)} is a bare path — local plugins need a file: or link: prefix`,
    )
  }
  const at = trimmed.startsWith('@') ? trimmed.indexOf('@', 1) : trimmed.indexOf('@')
  if (at === -1) {
    if (trimmed.startsWith('@') && trimmed.includes('/')) {
      return { name: trimmed } // bare @scope/name
    }
    if (trimmed.includes('/')) {
      throw new UsageError(
        `candidate ${JSON.stringify(trimmed)} is neither a package spec nor a local path ` +
          '(local plugins need a file: or link: prefix)',
      )
    }
    return { name: trimmed }
  }
  const name = trimmed.slice(0, at)
  const version = trimmed.slice(at + 1)
  if (name === '') throw new UsageError(`candidate ${JSON.stringify(raw)} has no package name`)
  if (version === '') return { name }
  return { name, version }
}

function basenameOf(target: string): string {
  const parts = target.split('/')
  const last = parts[parts.length - 1] ?? target
  return last === '' ? target : last
}

/** Whether the plan step needs pnpm (dependency mutations do). */
export function stepNeedsPnpm(action: LabAction): boolean {
  return action === 'add' || action === 'update' || action === 'remove'
}

export interface PlanBuildInput {
  action: LabAction
  /** add/update/remove target. */
  spec?: CandidateSpec
  /** config-apply: absolute overlay path inside the lab (materialized already). */
  overlayPath?: string
}

/** Build the run plan for one CLI verb (one transaction per run). */
export function buildPlan(input: PlanBuildInput): LabPlanRecord[] {
  switch (input.action) {
    case 'add': {
      const spec = input.spec
      if (spec === undefined) throw new UsageError('lab add needs a candidate spec')
      const localSpec = spec.localPath === undefined ? undefined : `file:${spec.localPath}`
      const registrySpec = spec.version === undefined ? undefined : `${spec.name}@${spec.version}`
      return [
        {
          seq: 1,
          action: 'add',
          id: spec.name,
          spec: localSpec ?? registrySpec ?? spec.name,
          ...(localSpec !== undefined
            ? { detail: 'local candidate (offline)' }
            : spec.version === undefined
              ? { detail: 'registry candidate at its latest version (needs the registry)' }
              : {}),
        },
      ]
    }
    case 'update': {
      const spec = input.spec
      if (spec === undefined) throw new UsageError('lab update needs a package name')
      const versionSpec = spec.version === undefined ? undefined : `${spec.name}@${spec.version}`
      const localSpec = spec.localPath === undefined ? undefined : `file:${spec.localPath}`
      return [
        {
          seq: 1,
          action: 'update',
          id: spec.name,
          ...(versionSpec !== undefined
            ? { spec: versionSpec }
            : localSpec !== undefined
              ? { spec: localSpec, detail: 'local candidate (offline)' }
              : {}),
        },
      ]
    }
    case 'remove': {
      const spec = input.spec
      if (spec === undefined) throw new UsageError('lab remove needs a package name')
      if (spec.version !== undefined || spec.localPath !== undefined) {
        throw new UsageError(
          `lab remove takes a bare package name, got ${JSON.stringify(spec.name)}`,
        )
      }
      return [{ seq: 1, action: 'remove', id: spec.name }]
    }
    case 'config-apply': {
      if (input.overlayPath === undefined)
        throw new UsageError('lab config apply needs a patch file')
      return [{ seq: 1, action: 'config-apply', overlayPath: input.overlayPath }]
    }
  }
}
