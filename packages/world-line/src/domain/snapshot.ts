/**
 * The snapshot model (WORLD-LINE-SPEC §5, §7): manifest shape, the single
 * read-pass profile analysis both `snapshot create` and `doctor` consume, and
 * the capture flow.
 *
 * Phase 1 capture policy:
 *
 * - Whitelist only: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
 *   and `cordis.patch.yml` (when present), plus the home-level patch layer.
 *   `node_modules`, the derived root config, and unknown extra files are
 *   never copied.
 * - The derived root config (`cordis.yml`) is recorded as presence +
 *   cleanliness — the host rewrites it to a fixed template on every boot.
 * - A file whose text carries secret shapes is **not** persisted to the
 *   plaintext vault: its hash and the reason are recorded (encrypted-vault
 *   support lands in Phase 4). Redacted structure summaries are still kept.
 * - Analysis failures are recorded, not fatal: the time machine must capture
 *   broken states too. Only unreadable files fail the snapshot.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../fs/hash.js'
import { profileDir } from '../fs/paths.js'
import type { HostAdapter } from '../host-adapters/types.js'
import { WORLD_LINE_FORMAT_VERSION, WORLD_LINE_VERSION } from '../identity.js'
import type { ClassifiedSpec, PatchEntrySummary, ProfileManifest } from './composition.js'
import {
  classifySpec,
  parsePatchListText,
  parseProfileManifest,
  scanFileText,
  summarizePatchEntries,
} from './composition.js'
import { FileError } from './errors.js'
import type { PnpmLockfile, ResolvedDependency } from './lockfile.js'
import { parsePnpmLockfile, resolveDependency } from './lockfile.js'
import type { ManagedRole, ProfileLayout } from './profile.js'
import { localPluginReceipt, scanProfileLayout } from './profile.js'
import type { ProfileReceipt } from './receipt.js'
import { receiptFromHashes } from './receipt.js'
import { redactText } from './redaction.js'

/** One captured composition file. */
export interface FileRecord {
  name: string
  role: ManagedRole
  size: number
  sha256: string
  /** Vault object id (sha256); null when the file was not persisted. */
  object: string | null
  /** Secret-skip policy outcome. */
  secretSkipped: boolean
  /** True when the bytes were stored encrypted in the snapshot's bundle. */
  secretStored?: boolean
  secretKinds: string[]
  /** Patch-role parse summary (redacted), when the file parses. */
  entries?: PatchEntrySummary[]
  /** Redacted parse error, when a patch/manifest file does not parse. */
  parseError?: string
}

/** One direct dependency with everything a diff needs. */
export interface DependencyRecord {
  name: string
  spec: string
  kind: ClassifiedSpec['kind']
  target?: string
  targetExists?: boolean
  gitHead?: string | null
  contentHash?: string | null
  resolved?: ResolvedDependency
}

/** Home-level patch layer record. */
export interface HomePatchRecord {
  present: boolean
  size?: number
  sha256?: string
  object?: string | null
  secretSkipped?: boolean
  secretKinds?: string[]
  entries?: PatchEntrySummary[]
  parseError?: string
}

/** The manifest persisted into the vault. */
export interface SnapshotManifest {
  formatVersion: number
  kind: 'profile-snapshot'
  id: string
  createdAt: string
  label: string | null
  parentId: string | null
  action: 'snapshot'
  candidateSource: null
  /**
   * Reserved by WORLD-LINE-SPEC §5 ("at least record … validation outcome and
   * retention") but meaningless for a Phase 1 capture: no boot probe runs on
   * read-only snapshots and no retention policy exists before Phase 5. Both
   * stay explicitly null so later phases can fill them without a format bump.
   */
  validation: null
  retention: null
  createdBy: {
    worldLineVersion: string
    environment: { node: string; os: string; arch: string }
  }
  dsh: { cliVersion: string | null; known: boolean; adapterId: string | null }
  profile: {
    name: string
    dshHome: string
    receipt: ProfileReceipt
    manifest: {
      name: string | null
      bundles: string[]
      patchReload: string | null
      parseError?: string
    }
    dependencies: DependencyRecord[]
  }
  files: FileRecord[]
  homePatch: HomePatchRecord | null
  derived: { rootConfigPresent: boolean; rootConfigClean: boolean | null }
  unmanaged: string[]
  /**
   * Encrypted secret bundle (Phase 4): present only when a secure key
   * service was available and at least one whitelist file carried secret
   * shapes. `null` means "no encrypted bundle" — either nothing was secret,
   * or the platform had no key service and secret-shaped files were skipped
   * (records carry `secretSkipped: true` and are not byte-restorable).
   */
  secretsBundle: {
    format: string
    sha256: string
    size: number
    entryCount: number
  } | null
}

/** The full read-pass result before persistence. */
export interface ProfileAnalysis {
  profileName: string
  profileDir: string
  layout: ProfileLayout
  files: FileRecord[]
  homePatch: HomePatchRecord | null
  derivedRoot: { present: boolean; clean: boolean | null }
  manifest: ProfileManifest | null
  manifestParseError: string | null
  lockfileParseError: string | null
  dependencies: DependencyRecord[]
  receipt: ProfileReceipt
  unmanaged: string[]
}

/** Whitelisted composition roles and their file names (WORLD-LINE-SPEC §5). */
const ROLE_FILE_NAMES: ReadonlyArray<{ role: ManagedRole; name: string }> = [
  { role: 'manifest', name: 'package.json' },
  { role: 'lockfile', name: 'pnpm-lock.yaml' },
  { role: 'workspace', name: 'pnpm-workspace.yaml' },
  { role: 'profile-patch', name: 'cordis.patch.yml' },
]

/** Analyse one profile in a single read pass; never writes anything. */
export async function analyzeProfile(options: {
  home: string
  profileName: string
  adapter: HostAdapter
  /** Called once per persisted file with its bytes (the vault hook). */
  store?: (name: string, bytes: Buffer) => Promise<void>
  /**
   * Phase 4: called for secret-bearing files when an encrypted secret
   * bundle is being captured. Return false to fall back to the plain
   * secret-skip policy (e.g. the key service disappeared mid-run).
   */
  secretBytes?: (entry: {
    name: string
    role: string
    sha256: string
    bytes: Buffer
  }) => Promise<boolean>
}): Promise<ProfileAnalysis> {
  const { home, profileName, adapter } = options
  const store = options.store ?? (async () => {})
  const dir = profileDir(home, profileName)
  const layout = await scanProfileLayout({
    profileDir: dir,
    rootConfigFilename: adapter.profile.rootConfigFilename,
    patchFilename: adapter.profile.patchFilename,
    workspaceFilename: adapter.profile.workspaceFilename,
    lockFilenames: adapter.profile.lockFilenames,
  })

  const files: FileRecord[] = []
  const hashes: Record<string, string> = {}
  let manifest: ProfileManifest | null = null
  let manifestParseError: string | null = null
  let lockfile: PnpmLockfile | null = null
  let lockfileParseError: string | null = null

  for (const { role, name } of ROLE_FILE_NAMES) {
    const presentName = layout.present[role]
    if (presentName === undefined) continue
    const filePath = join(dir, presentName)
    let bytes: Buffer
    try {
      bytes = await readFile(filePath)
    } catch (error) {
      throw new FileError(`failed to read ${filePath}: ${String(error)}`)
    }
    const sha256 = sha256Hex(bytes)
    hashes[name] = sha256
    const text = bytes.toString('utf8')
    const secretKinds = scanFileText(text)
    const secretSkipped = secretKinds.length > 0
    let secretStored = false
    if (secretKinds.length > 0 && options.secretBytes !== undefined) {
      secretStored = await options.secretBytes({
        name,
        role,
        sha256,
        bytes,
      })
    }
    const record: FileRecord = {
      name,
      role,
      size: bytes.byteLength,
      sha256,
      object: secretSkipped || secretStored ? null : sha256,
      secretSkipped: secretSkipped && !secretStored,
      ...(secretStored ? { secretStored: true } : {}),
      secretKinds,
    }
    if (!record.secretSkipped && !secretStored) {
      await store(name, bytes)
    }
    if (role === 'manifest') {
      try {
        manifest = parseProfileManifest(text, filePath)
      } catch (error) {
        manifestParseError = redactText(error instanceof Error ? error.message : String(error))
      }
    } else if (role === 'lockfile') {
      lockfile = parsePnpmLockfile(text)
      if (lockfile === null) lockfileParseError = 'lockfile is not a parseable pnpm lockfile'
    }
    files.push(record)
  }

  // Patch-role summary (redacted): profile layer and home layer.
  const patchRecord = files.find((record) => record.role === 'profile-patch')
  if (patchRecord !== undefined) {
    const text = await readProfileText(join(dir, patchRecord.name))
    if (text !== null) {
      try {
        patchRecord.entries = summarizePatchEntries(parsePatchListText(text, patchRecord.name))
      } catch (error) {
        patchRecord.parseError = redactText(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const homePatch = await analyzeHomePatch(home, store, options.secretBytes)

  let rootConfigClean: boolean | null = null
  if (layout.rootConfigPresent) {
    const rootText = await readProfileText(join(dir, adapter.profile.rootConfigFilename))
    rootConfigClean = rootText === adapter.profile.rootConfigTemplate
  }

  const dependencies: DependencyRecord[] = []
  if (manifest !== null) {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      dependencies.push(await describeDependency(name, spec, dir, lockfile))
    }
  }

  return {
    profileName,
    profileDir: dir,
    layout,
    files,
    homePatch,
    derivedRoot: { present: layout.rootConfigPresent, clean: rootConfigClean },
    manifest,
    manifestParseError,
    lockfileParseError,
    dependencies,
    receipt: receiptFromHashes(hashes),
    unmanaged: layout.unmanaged,
  }
}

/** Read a profile file's text; null when it vanished mid-analysis. */
async function readProfileText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Capture the home-level patch layer with the same skip policy. */
async function analyzeHomePatch(
  home: string,
  store: (name: string, bytes: Buffer) => Promise<void>,
  secretBytes?: (entry: {
    name: string
    role: string
    sha256: string
    bytes: Buffer
  }) => Promise<boolean>,
): Promise<HomePatchRecord | null> {
  const filePath = join(home, 'cordis.patch.yml')
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch {
    return { present: false }
  }
  const sha256 = sha256Hex(bytes)
  const text = bytes.toString('utf8')
  const secretKinds = scanFileText(text)
  const secretSkipped = secretKinds.length > 0
  let secretStored = false
  if (secretSkipped && secretBytes !== undefined) {
    secretStored = await secretBytes({
      name: 'cordis.patch.yml (home)',
      role: 'profile-patch',
      sha256,
      bytes,
    })
  }
  const record: HomePatchRecord = {
    present: true,
    size: bytes.byteLength,
    sha256,
    object: secretSkipped || secretStored ? null : sha256,
    secretSkipped: secretSkipped && !secretStored,
    ...(secretStored ? { secretStored: true } : {}),
    secretKinds,
  }
  if (!secretSkipped || secretStored) {
    if (!secretStored) await store('cordis.patch.yml (home)', bytes)
  }
  try {
    record.entries = summarizePatchEntries(parsePatchListText(text, 'home cordis.patch.yml'))
  } catch (error) {
    record.parseError = redactText(error instanceof Error ? error.message : String(error))
  }
  return record
}

/** Describe one dependency: spec kind, local receipts, lockfile resolution. */
async function describeDependency(
  name: string,
  spec: string,
  profileDir: string,
  lockfile: PnpmLockfile | null,
): Promise<DependencyRecord> {
  const classified: ClassifiedSpec = classifySpec(spec, profileDir)
  const record: DependencyRecord = {
    name,
    spec,
    kind: classified.kind,
  }
  if (classified.target !== undefined) {
    record.target = classified.target
    if (classified.kind === 'link' || classified.kind === 'file') {
      const receipt = await localPluginReceipt(classified.target)
      record.targetExists = receipt.exists
      if (receipt.exists) {
        record.gitHead = receipt.gitHead
        record.contentHash = receipt.contentHash
      }
    }
  }
  if (lockfile !== null) {
    const resolved = resolveDependency(lockfile, name)
    if (resolved !== undefined) record.resolved = resolved
  }
  return record
}

/** Assemble the manifest document for one analysis + capture meta. */
export function buildManifest(options: {
  analysis: ProfileAnalysis
  home: string
  id: string
  createdAt: string
  label: string | null
  parentId: string | null
  dsh: { cliVersion: string | null; known: boolean; adapterId: string | null }
  nodeVersion: string
  os: string
  arch: string
  secretsBundle?: SnapshotManifest['secretsBundle']
}): SnapshotManifest {
  const { analysis, home } = options
  return {
    formatVersion: WORLD_LINE_FORMAT_VERSION,
    kind: 'profile-snapshot',
    id: options.id,
    createdAt: options.createdAt,
    label: options.label,
    parentId: options.parentId,
    action: 'snapshot',
    candidateSource: null,
    validation: null,
    retention: null,
    createdBy: {
      worldLineVersion: WORLD_LINE_VERSION,
      environment: { node: options.nodeVersion, os: options.os, arch: options.arch },
    },
    dsh: options.dsh,
    profile: {
      name: analysis.profileName,
      dshHome: home,
      receipt: analysis.receipt,
      manifest: {
        name: analysis.manifest?.name ?? null,
        bundles: analysis.manifest?.bundles ?? [],
        patchReload: analysis.manifest?.patchReload ?? null,
        parseError: analysis.manifestParseError ?? undefined,
      },
      dependencies: analysis.dependencies,
    },
    files: analysis.files.map((record) => ({ ...record })),
    homePatch: analysis.homePatch === null ? null : { ...analysis.homePatch },
    derived: {
      rootConfigPresent: analysis.derivedRoot.present,
      rootConfigClean: analysis.derivedRoot.clean,
    },
    unmanaged: analysis.unmanaged,
    secretsBundle: options.secretsBundle ?? null,
  }
}

/** New snapshot id for a creation instant. */
export function newSnapshotId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const rand = Math.random().toString(16).slice(2, 10)
  return `snap-${stamp}-${rand}`
}
