/**
 * `dsh-world-line doctor` — read-only diagnostics (WORLD-LINE-SPEC §3, Phase 1).
 *
 * Every check runs independently and reports a verdict; any failed check
 * exits 1 (a verification failure), file/invocation errors exit 2. Doctor
 * never writes to the profile, the home, or the vault: analysis is
 * read-only, and an unknown DSH version is a warning, not a failure —
 * read-only diagnostics stay available under invariant 7's fail-closed
 * policy.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from '../context.js'
import { runtimeEnvironment } from '../context.js'
import { FileError } from '../domain/errors.js'
import { listTopLevel } from '../domain/profile.js'
import { redactText } from '../domain/redaction.js'
import type { FileRecord } from '../domain/snapshot.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { isStaleLock, readLock } from '../fs/lock.js'
import { objectsDir, profileDir, snapshotsDir, worldLineDir } from '../fs/paths.js'
import { findDshBinary, readDshVersion } from '../host-adapters/detect.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import type { VersionVerdict } from '../host-adapters/types.js'
import { readState } from '../vault/state.js'

/** One doctor check outcome. */
export interface DoctorCheck {
  id: string
  title: string
  status: 'ok' | 'fail' | 'warn' | 'info' | 'skip'
  /** Redacted free text explaining the verdict. */
  detail?: string
}

/** The full doctor answer. */
export interface DoctorResult {
  checks: DoctorCheck[]
  summary: { ok: number; failed: number; warned: number; info: number; skipped: number }
  dsh: { binary: string | null; verdict: VersionVerdict | null }
  environment: ReturnType<typeof runtimeEnvironment>
  profileName: string
}

/** Run one check, converting throws into failures with redacted messages. */
async function check(
  checks: DoctorCheck[],
  id: string,
  title: string,
  fn: () => Promise<Omit<DoctorCheck, 'id' | 'title'>>,
): Promise<void> {
  try {
    const outcome = await fn()
    checks.push({ id, title, ...outcome })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ id, title, status: 'fail', detail: redactText(message) })
  }
}

/** Run every doctor check against one context. */
export async function runDoctor(ctx: CliContext): Promise<DoctorResult> {
  const checks: DoctorCheck[] = []
  const { home, profileName, env, now } = ctx

  // -- dsh binary and version policy -------------------------------
  const binary = findDshBinary(env)
  let verdict: VersionVerdict | null = null
  await check(checks, 'dsh-binary', 'dsh binary on PATH', async () => {
    if (binary === null) {
      return {
        status: 'fail',
        detail: 'no dsh executable on PATH — install DSH or extend PATH before world-line work',
      }
    }
    return { status: 'ok', detail: binary.path }
  })
  await check(checks, 'dsh-version', 'dsh version against adapter evidence', async () => {
    if (binary === null) return { status: 'skip', detail: 'no binary to interrogate' }
    const version = readDshVersion(binary)
    verdict = adapterDsh01x.verdict(version, version === null)
    if (version === null) return { status: 'warn', detail: redactText(verdict.reason) }
    return verdict.known
      ? { status: 'ok', detail: redactText(verdict.reason) }
      : { status: 'warn', detail: redactText(verdict.reason) }
  })

  // -- world-line store ---------------------------------------------
  await check(checks, 'store-state', 'world-line store state', async () => {
    if (!existsSync(worldLineDir(home))) {
      return {
        status: 'info',
        detail: `${worldLineDir(home)} does not exist yet — the first snapshot creates it`,
      }
    }
    const state = await readState(home)
    const latest = Object.entries(state.lastSnapshots)
    return {
      status: 'ok',
      detail:
        `format ${state.formatVersion}; ` +
        (latest.length === 0
          ? 'no snapshots yet'
          : `latest per profile: ${latest.map(([name, id]) => `${name}=${id}`).join(', ')}`),
    }
  })

  // -- writer locks -------------------------------------------------
  await check(checks, 'writer-locks', 'per-profile writer locks', async () => {
    const lockDir = join(worldLineDir(home), 'locks')
    let names: string[]
    try {
      names = await readdir(lockDir)
    } catch {
      return { status: 'ok', detail: 'no locks directory — nothing is locked' }
    }
    const descriptions: string[] = []
    let staleCount = 0
    for (const name of names.filter((entry) => entry.endsWith('.lock')).sort()) {
      const content = await readLock(join(lockDir, name))
      if (content === null) {
        descriptions.push(`${name}: unreadable lock file`)
        continue
      }
      const stale = isStaleLock(content, now())
      if (stale) staleCount += 1
      descriptions.push(
        `${name}: pid ${content.pid} on ${content.host}${stale ? ' (stale)' : ' (held)'}`,
      )
    }
    if (descriptions.length === 0) return { status: 'ok', detail: 'no locks held' }
    return {
      status: staleCount > 0 ? 'warn' : 'info',
      detail:
        descriptions.join('; ') +
        (staleCount > 0
          ? ' — snapshot create refuses stale locks unless --break-stale-lock confirms removal'
          : ''),
    }
  })

  // -- profile ------------------------------------------------------
  await check(checks, 'profile-exists', 'profile directory exists and is readable', async () => {
    const dir = profileDir(home, profileName)
    const entries = await listTopLevel(dir)
    if (entries === null) {
      const profilesRoot = join(home, 'profiles')
      const names = await availableProfileNames(profilesRoot)
      throw new FileError(
        `profile ${JSON.stringify(profileName)} does not exist (available: ${names})`,
      )
    }
    return {
      status: 'ok',
      detail:
        `${dir} (${entries.filter((entry) => !entry.isDirectory).length} files, ` +
        `${entries.filter((entry) => entry.isDirectory).length} directories)`,
    }
  })

  // One end-to-end read pass; a thrown analysis error becomes one check.
  const analysis = await analyzeProfile({ home, profileName, adapter: adapterDsh01x }).catch(
    (error: unknown) => {
      void checks.push({
        id: 'profile-analysis',
        title: 'profile composition readable end to end',
        status: 'fail',
        detail: redactText(error instanceof Error ? error.message : String(error)),
      })
      return null
    },
  )

  if (analysis !== null) {
    const manifest = analysis.manifest
    await check(checks, 'profile-manifest', 'profile package.json parses', async () => {
      if (manifest === null) {
        const detail = analysis.manifestParseError
        return {
          status: 'fail',
          detail:
            detail ??
            'package.json is absent — initialize the profile with ' +
              '`dsh plugin --profile <name> add <package>` first',
        }
      }
      return {
        status: 'ok',
        detail:
          `name=${manifest.name ?? '(unnamed)'}, bundles=${manifest.bundles.length}, ` +
          `dependencies=${Object.keys(manifest.dependencies).length}`,
      }
    })

    await check(checks, 'bundles', 'dsh.profile.bundles present and ordered', async () => {
      if (manifest === null) return { status: 'skip', detail: 'manifest unreadable' }
      if (manifest.bundles.length === 0) {
        return {
          status: 'warn',
          detail: 'no bundles listed — the profile would boot with only launcher defaults',
        }
      }
      return { status: 'ok', detail: manifest.bundles.join(', ') }
    })

    await check(checks, 'profile-patch', 'user patch layer parses', async () => {
      return patchFileCheck(
        analysis.files.find((record) => record.role === 'profile-patch'),
        'no cordis.patch.yml — the profile has no user layer',
      )
    })

    await check(checks, 'home-patch', 'home patch layer parses', async () => {
      if (analysis.homePatch === null || !analysis.homePatch.present) {
        return { status: 'ok', detail: 'no home-level cordis.patch.yml' }
      }
      return patchFileCheck(
        {
          entries: analysis.homePatch.entries,
          parseError: analysis.homePatch.parseError,
        },
        'no home patch layer',
      )
    })

    await check(checks, 'workspace-settings', 'pnpm workspace settings', async () => {
      const record = analysis.files.find((entry) => entry.role === 'workspace')
      if (record === undefined) {
        return {
          status: 'warn',
          detail: 'no pnpm-workspace.yaml — the profile was not initialized by dsh plugin',
        }
      }
      return { status: 'ok', detail: 'pnpm-workspace.yaml present' }
    })

    await check(checks, 'lockfile', 'lockfile present', async () => {
      const record = analysis.files.find((entry) => entry.role === 'lockfile')
      if (record === undefined) {
        return { status: 'warn', detail: 'no lockfile — pnpm has never installed this profile' }
      }
      if (analysis.lockfileParseError !== null) {
        return { status: 'warn', detail: redactText(analysis.lockfileParseError) }
      }
      return { status: 'ok', detail: `${record.name} (${record.size} bytes)` }
    })

    await check(checks, 'derived-root', 'derived cordis.yml state', async () => {
      if (!analysis.derivedRoot.present) {
        return { status: 'info', detail: 'cordis.yml absent — dsh rewrites it on its next boot' }
      }
      if (analysis.derivedRoot.clean === false) {
        return {
          status: 'warn',
          detail: 'cordis.yml differs from the boot template — dsh will rewrite it on boot',
        }
      }
      return { status: 'ok', detail: 'cordis.yml matches the boot template' }
    })

    await check(checks, 'node-modules', 'profile node_modules', async () => {
      const installed = analysis.layout.entries.some(
        (entry) => entry.isDirectory && entry.name === 'node_modules',
      )
      if (!installed) {
        return {
          status: 'warn',
          detail: 'no node_modules — profile-local plugins are not installed',
        }
      }
      return { status: 'ok', detail: 'node_modules present' }
    })

    await check(checks, 'local-dependencies', 'link/file dependency targets', async () => {
      const local = analysis.dependencies.filter(
        (dependency) => dependency.kind === 'link' || dependency.kind === 'file',
      )
      if (local.length === 0) return { status: 'ok', detail: 'no local link/file dependencies' }
      const details = local.map((dependency) => {
        const target = dependency.targetExists === false ? 'MISSING target' : 'target present'
        const head =
          dependency.gitHead == null
            ? 'not a git checkout'
            : `HEAD ${dependency.gitHead.slice(0, 12)}`
        return `${dependency.name}: ${target}, ${head}`
      })
      const missing = local.filter((dependency) => dependency.targetExists === false)
      return {
        status: missing.length > 0 ? 'fail' : 'ok',
        detail: details.join('; '),
      }
    })

    await check(checks, 'secret-files', 'secret-bearing managed files', async () => {
      const flagged = analysis.files.filter((record) => record.secretSkipped)
      if (flagged.length === 0) {
        return { status: 'ok', detail: 'no managed file carries detected secret shapes' }
      }
      return {
        status: 'info',
        detail:
          `${flagged.map((record) => record.name).join(', ')} carry secret-shaped values — ` +
          `snapshot create stores them encrypted when a key service is available ` +
          `(macOS Keychain or $WORLD_LINE_SECRET_KEY); otherwise only their hashes are recorded`,
      }
    })

    await check(checks, 'vault', 'vault content', async () => {
      const objects = await countDirectory(objectsDir(home))
      const snapshots = await countDirectory(snapshotsDir(home))
      return {
        status: 'ok',
        detail:
          `${snapshots} snapshot manifest${snapshots === 1 ? '' : 's'}, ` +
          `${objects} content object${objects === 1 ? '' : 's'}`,
      }
    })
  }

  const summary = { ok: 0, failed: 0, warned: 0, info: 0, skipped: 0 }
  for (const outcome of checks) {
    const status = outcome.status
    if (status === 'fail') summary.failed += 1
    else if (status === 'warn') summary.warned += 1
    else if (status === 'skip') summary.skipped += 1
    else if (status === 'info') summary.info += 1
    else summary.ok += 1
  }
  return {
    checks,
    summary,
    dsh: { binary: binary?.path ?? null, verdict },
    environment: runtimeEnvironment(),
    profileName,
  }
}

/** Shared patch-file verdict for the profile and home layers. */
async function patchFileCheck(
  record: { entries?: FileRecord['entries']; parseError?: string } | undefined,
  absentDetail: string,
): Promise<Omit<DoctorCheck, 'id' | 'title'>> {
  if (record === undefined) return { status: 'warn', detail: absentDetail }
  if (record.parseError !== undefined) return { status: 'fail', detail: record.parseError }
  const entries = record.entries ?? []
  const ids = entries.flatMap((entry) => (entry.id !== undefined ? [entry.id] : []))
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  const plural = entries.length === 1 ? 'entry' : 'entries'
  return {
    status: duplicates.length > 0 ? 'warn' : 'ok',
    detail:
      `${entries.length} patch ${plural}` +
      (duplicates.length > 0 ? `, duplicated ids: ${duplicates.join(', ')}` : ''),
  }
}

/** Comma-joined sibling profile names for diagnostics. */
async function availableProfileNames(profilesRoot: string): Promise<string> {
  try {
    const entries = await readdir(profilesRoot, { withFileTypes: true })
    const names = entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort()
    if (names.length === 0) {
      return '(none — initialize with `dsh plugin --profile <name> add <package>`)'
    }
    return names.join(', ')
  } catch {
    return '(profiles directory unreadable)'
  }
}

/** Sorted names under one directory (0 when absent). */
async function countDirectory(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).length
  } catch {
    return 0
  }
}
