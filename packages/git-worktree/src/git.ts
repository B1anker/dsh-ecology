import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export interface Worktree {
  path: string
  head: string
  branch?: string
  detached: boolean
  bare: boolean
}

export interface CreateWorktreeInput {
  cwd: string
  branch: string
  baseRef?: string
  /** Explicit opt-in to replacing an existing generated worktree. */
  overwrite?: boolean
}

export interface CreatedWorktree {
  repositoryPath: string
  path: string
  branch?: string
  baseRef: string
}

export interface Branch {
  name: string
  current: boolean
}

/** What occupies a requested generated worktree name before creation. */
export interface WorktreeConflict {
  repositoryPath: string
  targetPath: string
  directoryExists: boolean
  /** True only when the directory is a linked worktree of this repository. */
  directoryWorktree?: Worktree
  branchExists: boolean
  /** A branch already checked out somewhere cannot be safely replaced. */
  branchWorktreePath?: string
}

/** One registered DSH workspace classified against its Git primary checkout. */
export interface WorkspaceGroupEntry {
  path: string
  repositoryPath?: string
  branch?: string
  detached?: boolean
}

export class GitWorktreeError extends Error {
  override name = 'GitWorktreeError'
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFile('git', args, {
      cwd,
      encoding: 'utf8',
      signal,
      maxBuffer: 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr).trim()
        : ''
    throw new GitWorktreeError(detail || `git ${args.join(' ')} failed`)
  }
}

export async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  const input = await realpath(cwd).catch(() => {
    throw new GitWorktreeError(`Current session directory does not exist: ${cwd}`)
  })
  const bare = (await git(input, ['rev-parse', '--is-bare-repository'], signal)).trim()
  if (bare === 'true')
    throw new GitWorktreeError(`Bare repositories cannot host a session worktree: ${input}`)

  // `--show-toplevel` identifies the current linked worktree, which would make
  // a second invocation create a sibling of that child. The common Git dir is
  // shared by all linked worktrees and resolves back to the primary checkout.
  const commonDir = (
    await git(input, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  ).trim()
  if (commonDir.length === 0 || basename(commonDir) !== '.git') {
    throw new GitWorktreeError(`Could not resolve the primary Git working tree for: ${input}`)
  }
  return dirname(commonDir)
}

export function assertBranchName(branch: string): void {
  if (branch.length === 0 || branch.length > 240) {
    throw new GitWorktreeError('branch must be between 1 and 240 characters')
  }
  if (
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    /[ ~^:?*\\[]/.test(branch) ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    }) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
  ) {
    throw new GitWorktreeError(`Invalid Git branch name: ${branch}`)
  }
}

function destinationFor(repositoryPath: string, branch: string): string {
  const safeBranch = branch.replaceAll('/', '--')
  return join(dirname(repositoryPath), `${basename(repositoryPath)}-worktrees`, safeBranch)
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

async function localBranchExists(
  repositoryPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await git(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
    return true
  } catch (error) {
    // `show-ref --verify --quiet` uses exit status 1 for an ordinary miss.
    // Re-run only actual Git failures as an actionable domain error.
    if (error instanceof GitWorktreeError) return false
    throw error
  }
}

/** Inspect a proposed named worktree before an irreversible overwrite prompt. */
export async function inspectWorktreeConflict(
  input: Pick<CreateWorktreeInput, 'cwd' | 'branch'>,
  signal?: AbortSignal,
): Promise<WorktreeConflict> {
  assertBranchName(input.branch)
  const repositoryPath = await repositoryRoot(input.cwd, signal)
  const targetPath = destinationFor(repositoryPath, input.branch)
  const worktrees = await listWorktrees(repositoryPath, signal)
  const directoryWorktree = worktrees.worktrees.find((worktree) => worktree.path === targetPath)
  const branchWorktree = worktrees.worktrees.find((worktree) => worktree.branch === input.branch)
  return {
    repositoryPath,
    targetPath,
    directoryExists: await pathExists(targetPath),
    ...(directoryWorktree === undefined ? {} : { directoryWorktree }),
    branchExists: await localBranchExists(repositoryPath, input.branch, signal),
    ...(branchWorktree === undefined ? {} : { branchWorktreePath: branchWorktree.path }),
  }
}

async function deleteLocalBranch(
  repositoryPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(repositoryPath, ['branch', '--delete', '--force', branch], signal)
}

async function overwriteWorktree(
  conflict: WorktreeConflict,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  if (conflict.directoryExists && conflict.directoryWorktree === undefined) {
    throw new GitWorktreeError(
      `Cannot overwrite directory because it is not a worktree managed by this repository: ${conflict.targetPath}`,
    )
  }
  // A branch in any other worktree must never be deleted as a side effect of
  // creating a new one. Git would reject it later; fail before deleting files.
  if (
    conflict.branchWorktreePath !== undefined &&
    conflict.branchWorktreePath !== conflict.targetPath
  ) {
    throw new GitWorktreeError(
      `Cannot overwrite branch "${branch}" because it is checked out at: ${conflict.branchWorktreePath}`,
    )
  }

  const removableBranches = new Set<string>()
  if (conflict.branchExists) removableBranches.add(branch)
  if (conflict.directoryWorktree?.branch !== undefined)
    removableBranches.add(conflict.directoryWorktree.branch)
  for (const candidate of removableBranches) {
    const checkedOut = (await listWorktrees(conflict.repositoryPath, signal)).worktrees.find(
      (worktree) => worktree.branch === candidate,
    )
    if (checkedOut !== undefined && checkedOut.path !== conflict.targetPath) {
      throw new GitWorktreeError(
        `Cannot overwrite branch "${candidate}" because it is checked out at: ${checkedOut.path}`,
      )
    }
  }

  if (conflict.directoryWorktree !== undefined) {
    await git(
      conflict.repositoryPath,
      ['worktree', 'remove', '--force', conflict.targetPath],
      signal,
    )
  }
  for (const candidate of removableBranches)
    await deleteLocalBranch(conflict.repositoryPath, candidate, signal)
}

export async function createWorktree(
  input: CreateWorktreeInput,
  signal?: AbortSignal,
): Promise<CreatedWorktree> {
  assertBranchName(input.branch)
  const repositoryPath = await repositoryRoot(input.cwd, signal)
  const baseRef = input.baseRef?.trim() || 'HEAD'
  const conflict = await inspectWorktreeConflict(
    { cwd: repositoryPath, branch: input.branch },
    signal,
  )
  const targetPath = conflict.targetPath

  if (conflict.directoryExists || conflict.branchExists) {
    if (input.overwrite !== true) {
      throw new GitWorktreeError(
        `Worktree already exists. Confirm overwrite to remove the existing directory and local branch: ${targetPath}`,
      )
    }
    await overwriteWorktree(conflict, input.branch, signal)
  }
  await mkdir(dirname(targetPath), { recursive: true })
  await git(repositoryPath, ['worktree', 'add', '-b', input.branch, targetPath, baseRef], signal)

  return { repositoryPath, path: targetPath, branch: input.branch, baseRef }
}

export async function listBranches(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ repositoryPath: string; branches: Branch[] }> {
  const repositoryPath = await repositoryRoot(cwd, signal)
  const current = (await git(repositoryPath, ['branch', '--show-current'], signal)).trim()
  const output = await git(
    repositoryPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    signal,
  )
  return {
    repositoryPath,
    branches: output
      .split('\n')
      .filter(Boolean)
      .map((name) => ({ name, current: name === current })),
  }
}

export async function createAutomaticWorktree(
  cwd: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<CreatedWorktree> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .toLowerCase()
  const suffix = Math.random().toString(36).slice(2, 6)
  return createWorktree({ cwd, branch: `dsh/${stamp}-${suffix}`, baseRef }, signal)
}

async function refreshedBaseRef(
  repositoryPath: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<string> {
  // UI selection is deliberately limited to local branches. If that branch
  // tracks a remote, fetch before creating so a new worktree starts from the
  // remote's newest commit without moving the source checkout itself.
  const tracking = (
    await git(
      repositoryPath,
      ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${baseRef}`],
      signal,
    )
  ).trim()
  if (tracking.length === 0) return baseRef
  const remote = tracking.split('/')[0]
  if (remote === undefined || remote.length === 0) return baseRef
  await git(repositoryPath, ['fetch', '--prune', remote], signal)
  return tracking
}

/** Create a named branch from the newest commit of its upstream, when any. */
export async function createWorktreeFromLatest(
  input: CreateWorktreeInput,
  signal?: AbortSignal,
): Promise<CreatedWorktree> {
  const repositoryPath = await repositoryRoot(input.cwd, signal)
  const baseRef = await refreshedBaseRef(repositoryPath, input.baseRef?.trim() || 'HEAD', signal)
  return createWorktree({ ...input, cwd: repositoryPath, baseRef }, signal)
}

/**
 * A source branch cannot be checked out by two worktrees simultaneously.
 * With no requested branch name, create a detached worktree at the newest
 * source commit instead, leaving the source branch and its checkout untouched.
 */
export async function createDetachedWorktreeFromLatest(
  cwd: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<CreatedWorktree> {
  const repositoryPath = await repositoryRoot(cwd, signal)
  const refreshedRef = await refreshedBaseRef(repositoryPath, baseRef.trim() || 'HEAD', signal)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .toLowerCase()
  const suffix = Math.random().toString(36).slice(2, 6)
  const targetPath = destinationFor(repositoryPath, `dsh-detached-${stamp}-${suffix}`)
  if (await pathExists(targetPath))
    throw new GitWorktreeError(`Refusing to use existing path: ${targetPath}`)
  await mkdir(dirname(targetPath), { recursive: true })
  await git(repositoryPath, ['worktree', 'add', '--detach', targetPath, refreshedRef], signal)
  return { repositoryPath, path: targetPath, baseRef: refreshedRef }
}

function parseWorktreePorcelain(output: string): Worktree[] {
  const records: Worktree[] = []
  let current: Partial<Worktree> | undefined
  for (const line of output.split('\n')) {
    if (line.length === 0) {
      if (current?.path !== undefined && current.head !== undefined)
        records.push(current as Worktree)
      current = undefined
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') current = { path: value, detached: false, bare: false }
    else if (current !== undefined && key === 'HEAD') current.head = value
    else if (current !== undefined && key === 'branch')
      current.branch = value.replace(/^refs\/heads\//, '')
    else if (current !== undefined && key === 'detached') current.detached = true
    else if (current !== undefined && key === 'bare') current.bare = true
  }
  if (current?.path !== undefined && current.head !== undefined) records.push(current as Worktree)
  return records
}

export async function listWorktrees(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ repositoryPath: string; worktrees: Worktree[] }> {
  const repositoryPath = await repositoryRoot(cwd, signal)
  const output = await git(repositoryPath, ['worktree', 'list', '--porcelain'], signal)
  return { repositoryPath, worktrees: parseWorktreePorcelain(output) }
}

/**
 * Remove a linked worktree's directory and its local branch. The primary
 * checkout can never be removed through this operation.
 */
export async function removeWorktree(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ repositoryPath: string; path: string; branch?: string }> {
  const path = await realpath(cwd).catch(() => {
    throw new GitWorktreeError(`Worktree directory does not exist: ${cwd}`)
  })
  const repositoryPath = await repositoryRoot(path, signal)
  if (path === repositoryPath) {
    throw new GitWorktreeError('The primary repository checkout cannot be removed as a worktree')
  }
  const listed = await listWorktrees(repositoryPath, signal)
  const target = listed.worktrees.find((worktree) => worktree.path === path)
  if (target === undefined)
    throw new GitWorktreeError(`Not a linked worktree of this repository: ${path}`)

  await git(repositoryPath, ['worktree', 'remove', '--force', path], signal)
  if (target.branch !== undefined) await deleteLocalBranch(repositoryPath, target.branch, signal)
  return { repositoryPath, path, ...(target.branch === undefined ? {} : { branch: target.branch }) }
}

/**
 * Classify arbitrary registered workspace paths into their Git worktree
 * families. Non-Git paths remain entries without a repository owner.
 * @param paths - Existing DSH workspace paths.
 * @param signal - Optional cancellation propagated to Git.
 * @returns A stable path-sorted classification usable by a sidebar tree.
 */
export async function classifyWorkspacePaths(
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<WorkspaceGroupEntry[]> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        const canonicalPath = await realpath(path)
        const repositoryPath = await repositoryRoot(canonicalPath, signal)
        const worktrees = await listWorktrees(canonicalPath, signal)
        const current = worktrees.worktrees.find((worktree) => worktree.path === canonicalPath)
        return {
          path: canonicalPath,
          repositoryPath,
          ...(current?.branch !== undefined ? { branch: current.branch } : {}),
          ...(current?.detached === true ? { detached: true } : {}),
        }
      } catch (error) {
        if (error instanceof GitWorktreeError) return { path }
        throw error
      }
    }),
  )
}

export function resolveSessionCwd(sessionCwd: string | undefined): string {
  if (sessionCwd === undefined || !isAbsolute(sessionCwd)) {
    throw new GitWorktreeError(
      'This tool requires a DSH session with an absolute workspace directory',
    )
  }
  return resolve(sessionCwd)
}
