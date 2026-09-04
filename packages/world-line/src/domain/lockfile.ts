/**
 * pnpm lockfile reading for resolved-dependency records.
 *
 * Profiles are pnpm workspaces (`pnpm-lock.yaml`, lockfileVersion 9.0 for the
 * exercised DSH 0.1.2-rc.1 era). Only the pieces a snapshot manifest needs
 * are read: the `importers.'.'` direct-dependency resolutions and the
 * matching `packages` entries' resolved version, integrity, and registry URL.
 * Parsing is best-effort — a lockfile we cannot map degrades to
 * hash-only tracking, never a failure.
 */

import yaml from 'js-yaml'

/** One resolved direct dependency, from lockfile evidence. */
export interface ResolvedDependency {
  /** Resolved version, when the lockfile pins one. */
  version?: string
  /** Package integrity hash from the resolution. */
  integrity?: string
  /** Registry tarball/URL the package resolved from. */
  url?: string
}

interface ResolvedPackage {
  version?: string
  resolution?: Record<string, string>
}

/** The parsed lockfile pieces snapshots consume. */
export interface PnpmLockfile {
  /** Direct-dependency resolutions of the profile workspace root. */
  importer: Record<string, { specifier?: string; version?: string }>
  /** Resolved package index by pnpm key (`/name@version(peers…)`). */
  packages: Map<string, ResolvedPackage>
}

/**
 * Parse a pnpm-lock.yaml text into the pieces snapshots use. Returns null
 * when the text is not a parseable pnpm lockfile.
 */
export function parsePnpmLockfile(text: string): PnpmLockfile | null {
  let root: unknown
  try {
    root = yaml.load(text, { schema: yaml.JSON_SCHEMA })
  } catch {
    return null
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return null
  const record = root as Record<string, unknown>
  const importers = record.importers
  const importerRoot =
    importers !== null && typeof importers === 'object' && !Array.isArray(importers)
      ? ((importers as Record<string, unknown>)['.'] ?? {})
      : {}
  const dependencies =
    typeof importerRoot === 'object' && importerRoot !== null && !Array.isArray(importerRoot)
      ? (importerRoot as Record<string, unknown>).dependencies
      : undefined

  const importer: PnpmLockfile['importer'] = {}
  if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const [name, entry] of Object.entries(dependencies as Record<string, unknown>)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const dep = entry as Record<string, unknown>
        importer[name] = {
          specifier: typeof dep.specifier === 'string' ? dep.specifier : undefined,
          version: typeof dep.version === 'string' ? dep.version : undefined,
        }
      }
    }
  }

  const packages = record.packages
  const resolved = new Map<string, ResolvedPackage>()
  if (packages !== null && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const pkg = entry as Record<string, unknown>
        const resolution =
          pkg.resolution !== null && typeof pkg.resolution === 'object'
            ? (pkg.resolution as Record<string, string>)
            : undefined
        resolved.set(key, {
          version: typeof pkg.version === 'string' ? pkg.version : undefined,
          resolution,
        })
      }
    }
  }
  return { importer, packages: resolved }
}

/**
 * Resolve one direct dependency against a parsed lockfile: the exact
 * `importer` version first, then the first `packages` key whose name prefix
 * matches. Returns undefined when the lockfile carries no resolution.
 */
export function resolveDependency(
  lockfile: PnpmLockfile,
  name: string,
): ResolvedDependency | undefined {
  const importerEntry = lockfile.importer[name]
  const exact =
    importerEntry?.version !== undefined ? packageKey(name, importerEntry.version) : undefined
  const entry =
    (exact !== undefined ? lockfile.packages.get(exact) : undefined) ??
    findPrefixEntry(lockfile.packages, `/${name}@`)
  if (entry === undefined) return undefined
  const out: ResolvedDependency = {}
  if (entry.version !== undefined) out.version = entry.version
  const integrity = entry.resolution?.integrity
  if (integrity !== undefined) out.integrity = integrity
  const tarball = entry.resolution?.tarball
  if (tarball !== undefined) out.url = tarball
  return Object.keys(out).length > 0 ? out : undefined
}

/** pnpm packages-map key for a name/version pair. */
function packageKey(name: string, version: string): string {
  return `/${name}@${version}`
}

/** First packages key starting with `prefix`, lexicographic. */
function findPrefixEntry(
  packages: Map<string, ResolvedPackage>,
  prefix: string,
): ResolvedPackage | undefined {
  for (const key of packages.keys()) {
    if (key.startsWith(prefix)) return packages.get(key)
  }
  return undefined
}
