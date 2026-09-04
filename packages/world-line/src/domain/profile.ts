/**
 * Profile directory layout scanning: which top-level files exist, which the
 * composition whitelist manages, what is derived, and what is unmanaged.
 *
 * Whitelist semantics (WORLD-LINE-SPEC §5): never recurse or snapshot
 * `node_modules`, never snapshot the derived root config, and leave unknown
 * extra top-level files alone (they are listed as `unmanaged` so a restore
 * planner can refuse to silently drop them later).
 */

import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { sha256Hex } from '../fs/hash.js'
import { FileError } from './errors.js'

/** The roles the whitelist understands. */
export type ManagedRole = 'manifest' | 'lockfile' | 'workspace' | 'profile-patch'

/** One top-level profile entry. */
export interface ProfileEntry {
  name: string
  isDirectory: boolean
}

/** Layout facts about one profile directory. */
export interface ProfileLayout {
  /** Top-level entries, sorted by name. */
  entries: ProfileEntry[]
  /** Managed whitelist files that exist, keyed by role. */
  present: Partial<Record<ManagedRole, string>>
  /** Managed files expected by the adapter but absent (informational). */
  absent: ManagedRole[]
  /** Whether the derived root config (`cordis.yml`) exists. */
  rootConfigPresent: boolean
  /** Extra top-level regular files the whitelist does not manage. */
  unmanaged: string[]
}

/** List top-level entries of a directory, sorted; `null` when absent. */
export async function listTopLevel(dir: string): Promise<ProfileEntry[] | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new FileError(`failed to read directory ${dir}`)
  }
  return entries
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Ensure one profile directory exists before any writer-side work (lock
 * acquisition, store creation). Throws {@link FileError} naming the sibling
 * profiles when it is missing, so a wrong profile name is self-explaining
 * and nothing (store dirs included) is created for a non-existent profile.
 */
export async function ensureProfileDir(profileDirPath: string): Promise<ProfileEntry[]> {
  const entries = await listTopLevel(profileDirPath)
  if (entries !== null) return entries
  const profilesRoot = dirname(profileDirPath)
  let candidates: string[]
  try {
    candidates = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    candidates = []
  }
  const hint =
    candidates.length === 0
      ? 'this DSH home has no profiles yet — create one with the dsh CLI first'
      : `available profiles: ${candidates.join(', ')}`
  throw new FileError(
    `profile ${JSON.stringify(basename(profileDirPath))} does not exist under ${profilesRoot} — ${hint}`,
  )
}

/**
 * Scan one profile directory against an adapter's layout contract. Throws
 * {@link FileError} when the directory itself is missing or unreadable.
 */
export async function scanProfileLayout(options: {
  profileDir: string
  rootConfigFilename: string
  patchFilename: string
  workspaceFilename: string
  lockFilenames: readonly string[]
}): Promise<ProfileLayout> {
  const { profileDir } = options
  const entries = await ensureProfileDir(profileDir)
  const names = new Set(entries.map((entry) => entry.name))
  const present: ProfileLayout['present'] = {}
  const absent: ManagedRole[] = []
  const assign = (role: ManagedRole, fileName: string | undefined): void => {
    if (fileName === undefined) return
    if (names.has(fileName)) present[role] = fileName
    else absent.push(role)
  }
  assign('manifest', 'package.json')
  assign('lockfile', options.lockFilenames[0])
  assign('workspace', options.workspaceFilename)
  assign('profile-patch', options.patchFilename)
  const unmanaged = entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name !== 'package.json' &&
        name !== options.lockFilenames[0] &&
        name !== options.workspaceFilename &&
        name !== options.patchFilename &&
        name !== options.rootConfigFilename,
    )
  return {
    entries,
    present,
    absent,
    rootConfigPresent: names.has(options.rootConfigFilename),
    unmanaged,
  }
}

/** Read one small text-ish profile file; `null` when absent. */
export async function readProfileTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new FileError(`failed to read ${file}`)
  }
}

/**
 * Local-plugin receipt for a link:/file: target: does it exist, is it inside
 * a git checkout (HEAD sha), and what does its dsh-relevant content hash to?
 * Content hashing covers the package manifest plus any root
 * `cordis.patch.yml` — the two files that decide a bundle's composition
 * behavior. Full-tree vendoring arrives with `--vendor-local-plugin` in the
 * Phase 4 object vault.
 */
export async function localPluginReceipt(targetDir: string): Promise<{
  exists: boolean
  gitHead: string | null
  contentHash: string | null
  files: string[]
}> {
  let info
  try {
    info = await stat(targetDir)
  } catch {
    return { exists: false, gitHead: null, contentHash: null, files: [] }
  }
  if (!info.isDirectory()) {
    return { exists: false, gitHead: null, contentHash: null, files: [] }
  }

  const gitHead = readGitHead(targetDir)
  const hashed = await hashPluginFiles(targetDir)
  return {
    exists: true,
    gitHead,
    contentHash: hashed.hash,
    files: hashed.files,
  }
}

/** Ask git for the HEAD of the repository containing `dir`; null when not git. */
export function readGitHead(dir: string): string | null {
  try {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
    if (result.error !== undefined || result.status !== 0) return null
    const head = (result.stdout ?? '').trim()
    return /^[0-9a-f]{40}$/.test(head) ? head : null
  } catch {
    return null
  }
}

/** Hash `package.json` + `cordis.patch.yml` at a target's root, if present. */
async function hashPluginFiles(dir: string): Promise<{ hash: string | null; files: string[] }> {
  const names = ['package.json', 'cordis.patch.yml']
  const parts: string[] = []
  const files: string[] = []
  for (const name of names) {
    try {
      const bytes = await readFile(join(dir, name))
      parts.push(`${name}:${sha256Hex(bytes)}`)
      files.push(name)
    } catch {
      // Optional files can be absent.
    }
  }
  if (parts.length === 0) return { hash: null, files }
  return { hash: sha256Hex(parts.join('\n')), files }
}
