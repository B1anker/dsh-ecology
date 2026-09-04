/**
 * Lab creation (WORLD-LINE-SPEC §5/§6, Phase 2): clone the whitelisted files
 * of one real profile into an isolated lab.
 *
 * Order: profile existence preflight → exclusive profile lock (same discipline
 * as snapshots; the receipt must describe a quiescent source) → one read pass
 * with `analyzeProfile` (no store hook — labs hold bytes, not vault objects) →
 * fresh `labs/<id>` skeleton with its own DSH home, profile dir, pnpm store,
 * and logs → copy the whitelisted composition files (manifest, lockfile,
 * workspace, profile patch; the derived root config is NOT copied — the host
 * regenerates `cordis.yml` on first boot) → write the §5 manifest.
 *
 * Never writes the real profile or home; the lock guarantees no other
 * world-line writer is mid-flight on the source.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from '../context.js'
import { runtimeEnvironment } from '../context.js'
import { FileError } from '../domain/errors.js'
import { ensureProfileDir } from '../domain/profile.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import type { KnownHost } from './gate.js'
import { labDir, labLogDir, labProfileDir, labStoreDir, newLabId } from './layout.js'
import type { LabManifest } from './manifest.js'
import { writeLabManifest } from './manifest.js'

export interface CreatedLab {
  manifest: LabManifest
  /** The lab profile directory (profile-name keyed inside the lab home). */
  labProfileDir: string
  /** Copied whitelisted file names (the clone set). */
  copied: string[]
}

/** Whitelisted composition roles cloned from the source profile (§5). */
export const WHITELIST_FILE_NAMES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
] as const

/**
 * Create one lab from the real profile `profileName` under the context home.
 * The derived root config (`cordis.yml`) is deliberately not copied: the host
 * rewrites it on every boot from bundles + patch, and a stale copy would make
 * the lab diverge from compose on first run.
 */
export async function createLab(
  ctx: CliContext,
  host: KnownHost,
  profileName: string,
): Promise<CreatedLab> {
  const now = ctx.now()
  const sourceDir = profileDir(ctx.home, profileName)
  await ensureProfileDir(sourceDir)

  const lock = await acquireLock({
    lockPath: profileLockPath(ctx.home, profileName),
    purpose: `lab create from ${profileName}`,
    breakStale: ctx.breakStaleLock,
    now,
  })
  try {
    const analysis = await analyzeProfile({
      home: ctx.home,
      profileName,
      adapter: adapterDsh01x,
    })

    const id = newLabId(now)
    const targetDir = labProfileDir(ctx.home, id, profileName)
    await mkdir(labDir(ctx.home, id), { recursive: true })
    await mkdir(targetDir, { recursive: true })
    await mkdir(labStoreDir(ctx.home, id), { recursive: true })
    await mkdir(labLogDir(ctx.home, id), { recursive: true })

    const copied: string[] = []
    for (const record of analysis.files) {
      if (!(WHITELIST_FILE_NAMES as readonly string[]).includes(record.name)) continue
      const bytes = await readFile(join(sourceDir, record.name))
      await writeFileAtomic(join(targetDir, record.name), bytes)
      copied.push(record.name)
    }
    if (!copied.includes('package.json')) {
      throw new FileError(
        `profile ${profileName} has no manifest (package.json) — nothing to clone`,
      )
    }

    const lockfileRecord = analysis.files.find((record) => record.role === 'lockfile')
    const manifest: LabManifest = {
      manifestVersion: 1,
      id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      adapterId: host.adapterId,
      dshVersion: host.raw,
      runtime: runtimeEnvironment(),
      source: { profileName, receipt: analysis.receipt.tree },
      ...(lockfileRecord !== undefined ? { lockfileHash: lockfileRecord.sha256 } : {}),
      state: 'created',
      runCount: 0,
      plan: [],
      retention: { cleanupMode: 'keep-on-failure' },
    }
    await writeLabManifest(ctx.home, manifest, now)

    return { manifest, labProfileDir: targetDir, copied }
  } finally {
    await lock.release()
  }
}
