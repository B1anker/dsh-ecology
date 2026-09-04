import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import {
  assertBranchName,
  classifyWorkspacePaths,
  createDetachedWorktreeFromLatest,
  createWorktree,
  createWorktreeFromLatest,
  GitWorktreeError,
  inspectWorktreeConflict,
  listBranches,
  listWorktrees,
  removeWorktree,
  repositoryRoot,
} from '../src/git.js'

const temporaryDirectories: string[] = []

async function repository(): Promise<string> {
  const container = await mkdtemp(join(tmpdir(), 'dsh-git-worktree-'))
  temporaryDirectories.push(container)
  const path = join(container, 'repo')
  await mkdir(path)
  execFileSync('git', ['init'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: path })
  await writeFile(join(path, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: path })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: path })
  // GitHub's runner can ignore --initial-branch for an empty repository.
  // Rename after the first commit so this fixture always exposes main.
  execFileSync('git', ['branch', '--move', '--force', 'main'], { cwd: path })
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('worktree operations', () => {
  it('creates a sibling worktree from the session repository and lists it', async () => {
    const cwd = await repository()
    const created = await createWorktree({ cwd, branch: 'feat/example' })

    expect(created.repositoryPath).toMatch(/\/repo$/)
    expect(created.branch).toBe('feat/example')
    expect(created.path).toMatch(/\/repo-worktrees\/feat--example$/)

    const listed = await listWorktrees(created.path)
    expect(listed.repositoryPath).toBe(created.repositoryPath)
    expect(listed.worktrees.map((worktree) => worktree.branch)).toContain('feat/example')
  })

  it('rejects unsafe branch names before invoking Git', () => {
    for (const branch of ['../escape', 'feat//double', 'feat..double', 'feature name', '']) {
      expect(() => assertBranchName(branch)).toThrow(GitWorktreeError)
    }
  })

  it('will not overwrite an already existing destination', async () => {
    const cwd = await repository()
    await createWorktree({ cwd, branch: 'feat/example' })
    await expect(createWorktree({ cwd, branch: 'feat/example' })).rejects.toThrow(
      'Confirm overwrite',
    )
  })

  it('reports an existing path and branch before an explicit overwrite', async () => {
    const cwd = await repository()
    const created = await createWorktree({ cwd, branch: 'feat/example' })
    const conflict = await inspectWorktreeConflict({ cwd, branch: 'feat/example' })
    expect(conflict).toMatchObject({
      targetPath: created.path,
      directoryExists: true,
      branchExists: true,
      directoryWorktree: { branch: 'feat/example' },
      branchWorktreePath: created.path,
    })
  })

  it('replaces a generated worktree only after explicit overwrite', async () => {
    const cwd = await repository()
    const first = await createWorktree({ cwd, branch: 'feat/replace' })
    await writeFile(join(first.path, 'scratch.txt'), 'remove me')
    const replacement = await createWorktree({ cwd, branch: 'feat/replace', overwrite: true })
    expect(replacement.path).toBe(first.path)
    await expect(access(join(replacement.path, 'scratch.txt'))).rejects.toThrow()
    expect(
      (await listWorktrees(cwd)).worktrees.filter((item) => item.branch === 'feat/replace'),
    ).toHaveLength(1)
  })

  it('removes a linked worktree directory and its local branch', async () => {
    const cwd = await repository()
    const created = await createWorktree({ cwd, branch: 'feat/remove' })
    await expect(removeWorktree(created.path)).resolves.toMatchObject({
      path: created.path,
      branch: 'feat/remove',
    })
    await expect(access(created.path)).rejects.toThrow()
    expect((await listBranches(cwd)).branches.map((item) => item.name)).not.toContain('feat/remove')
    await expect(removeWorktree(cwd)).rejects.toThrow('primary repository')
  })

  it('creates a detached worktree when no new branch is requested', async () => {
    const cwd = await repository()
    const created = await createDetachedWorktreeFromLatest(cwd, 'main')
    expect(created.branch).toBeUndefined()
    const listed = await listWorktrees(created.path)
    expect(listed.worktrees.find((worktree) => worktree.path === created.path)?.detached).toBe(true)
  })

  it('creates a named worktree from the newest upstream commit', async () => {
    const cwd = await repository()
    const container = join(cwd, '..')
    const remote = join(container, 'remote.git')
    const updater = join(container, 'updater')
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd })
    execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd })
    execFileSync('git', ['clone', '--branch', 'main', remote, updater])
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: updater })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: updater })
    await writeFile(join(updater, 'LATEST.md'), 'latest\n')
    execFileSync('git', ['add', 'LATEST.md'], { cwd: updater })
    execFileSync('git', ['commit', '-m', 'latest'], { cwd: updater })
    execFileSync('git', ['push', 'origin', 'main'], { cwd: updater })

    const created = await createWorktreeFromLatest({ cwd, baseRef: 'main', branch: 'feat/latest' })
    const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: updater,
      encoding: 'utf8',
    }).trim()
    const worktreeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: created.path,
      encoding: 'utf8',
    }).trim()
    expect(worktreeHead).toBe(remoteHead)
  })

  it('classifies a primary checkout and linked worktree under one repository', async () => {
    const cwd = await repository()
    const created = await createWorktree({ cwd, branch: 'feat/grouped' })
    const groups = await classifyWorkspacePaths([created.path, cwd, join(cwd, '..')])
    const root = await repositoryRoot(cwd)
    expect(groups[0]).toMatchObject({
      path: created.path,
      repositoryPath: root,
      branch: 'feat/grouped',
    })
    expect(groups[1]).toMatchObject({ path: root, repositoryPath: root, branch: 'main' })
    expect(groups[2]).toEqual({ path: join(cwd, '..') })
  })
})
