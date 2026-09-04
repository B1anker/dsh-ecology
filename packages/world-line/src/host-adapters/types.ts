/**
 * HostAdapter contract (WORLD-LINE-SPEC §8): every DSH-version-sensitive fact
 * lives behind this interface and in `host-adapters/`, never in commands or
 * domain code.
 *
 * Phase 0/1 implements the read-only surface: binary and version detection,
 * the known-version policy (fail closed for labs — Phase 2+ — while doctor and
 * snapshot stay allowed for any version), and the profile-layout contract
 * facts the vault needs to snapshot a profile without booting DSH. The launch
 * / compose / browser-probe members arrive with the Phase 2/3 lab launcher.
 */

/** A parsed `dsh --version` answer. */
export interface DshVersion {
  /** The raw first line the binary printed. */
  raw: string
  core: { major: number; minor: number; patch: number }
  /** Prerelease tag such as `rc.1`, or null for a stable release. */
  prerelease: string | null
}

/** How the version policy classifies one installed binary. */
export interface VersionVerdict {
  version: DshVersion | null
  /** Whether `--version` could not be obtained at all. */
  undetectable: boolean
  /** Whether this exact version was exercised against this adapter. */
  known: boolean
  /** Human explanation backing `known`. */
  reason: string
}

/** The profile-layout facts one adapter generation vouches for. */
export interface ProfileLayoutContract {
  /** Directory under `<home>/profiles`. */
  profilesDirName: string
  /** Root config filename inside a profile (rewritten on every boot). */
  rootConfigFilename: string
  /** The exact bytes the host rewrites that root to (the canonical root). */
  rootConfigTemplate: string
  /** The user patch layer inside a profile. */
  patchFilename: string
  /** The pnpm workspace settings file. */
  workspaceFilename: string
  /** Lockfile names the profile's package manager writes, in preference order. */
  lockFilenames: readonly string[]
  /** Shipped profile templates auto-initialized on first use, by name. */
  templates: Readonly<Record<string, { bundles: readonly string[]; patchReload: string }>>
  /** Bundle list a plugin init uses for a name with no shipped template. */
  defaultBundles: readonly string[]
}

/** One host adapter generation. */
export interface HostAdapter {
  /** Stable adapter id, e.g. `dsh-0.1.x`. */
  readonly id: string
  /** Exact version strings exercised against this adapter (the evidence set). */
  readonly testedVersions: readonly string[]
  /** The profile-layout facts this adapter vouches for. */
  readonly profile: ProfileLayoutContract

  /** Classify one parsed version against the evidence set. */
  verdict(version: DshVersion | null, undetectable?: boolean): VersionVerdict
}
