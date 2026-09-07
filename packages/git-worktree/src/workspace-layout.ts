import type { WorkspaceGroupEntry } from './client-contracts.js'

function normalizePathKey(path: string): string {
  return path.replace(/^\/private\/var\//, '/var/')
}

function trimSlash(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function parentDir(path: string): string {
  const trimmed = trimSlash(path)
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return trimmed
  return trimmed.slice(0, index)
}

function baseName(path: string): string {
  const trimmed = trimSlash(path)
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

/**
 * Parse `{repo}-worktrees/{name}` back to the expected primary checkout path.
 * Shared by the server classifier and the client-side local fallback.
 */
export function primaryFromWorktreeLayout(path: string): string | undefined {
  const parent = parentDir(path)
  const folder = baseName(parent)
  if (!folder.endsWith('-worktrees')) return undefined
  const repoName = folder.slice(0, -'-worktrees'.length)
  if (repoName.length === 0) return undefined
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  return `${parentDir(parent)}${sep}${repoName}`
}

/**
 * Nest worktrees under their primary checkout using only registered paths.
 * Used so the sidebar never blocks on `workspace-groups` during login/boot.
 */
export function inferWorkspaceGroupsLocal(paths: readonly string[]): WorkspaceGroupEntry[] {
  const byKey = new Map<string, string>()
  for (const path of paths) byKey.set(normalizePathKey(path), path)

  return paths.map((path) => {
    const expectedPrimary = primaryFromWorktreeLayout(path)
    if (expectedPrimary !== undefined) {
      const owner = byKey.get(normalizePathKey(expectedPrimary))
      if (owner !== undefined) {
        return { path, repositoryPath: owner, status: 'active' as const }
      }
    }

    const ownsChild = paths.some((candidate) => {
      if (candidate === path) return false
      const primary = primaryFromWorktreeLayout(candidate)
      return primary !== undefined && normalizePathKey(primary) === normalizePathKey(path)
    })
    if (ownsChild) return { path, repositoryPath: path, status: 'active' as const }
    return { path }
  })
}

/** Merge server classify results onto a local inference baseline. */
export function mergeWorkspaceGroups(
  local: readonly WorkspaceGroupEntry[],
  remote: readonly WorkspaceGroupEntry[],
): WorkspaceGroupEntry[] {
  const remoteByKey = new Map(remote.map((entry) => [normalizePathKey(entry.path), entry]))
  return local.map((entry) => {
    const hit = remoteByKey.get(normalizePathKey(entry.path))
    if (hit === undefined) return entry
    return {
      ...entry,
      ...hit,
      // Prefer the live registered path casing from the workspace list.
      path: entry.path,
    }
  })
}
