export const LOCALE_NS = 'git-worktree'

export type WorktreeCopy = Record<string, string>

export const ZH: WorktreeCopy = {
  newWorktree: '新建 worktree',
  creating: '创建中…',
  selectGitWorkspace: '请先选择一个 Git 工作区',
  loadingBranches: '正在读取分支…',
  noBranches: '没有匹配的分支',
  targetBranch: '目标分支',
  searchBranch: '搜索分支',
  targetBranchList: '目标分支列表',
  chooseTarget: '选择目标分支',
  newBranch: '新分支名称（可选）',
  newBranchPlaceholder: '例如 feat/my-change',
  detachedHint: '留空将创建 detached worktree。',
  create: '创建 worktree',
  updating: '更新并创建中…',
  createDialog: '新建 worktree',
  conflictTitle: '发现已有 worktree',
  conflictBody:
    '“{branch}”对应的目录或本地分支已经存在。覆盖会物理删除现有 worktree 目录及其本地分支，无法恢复。',
  cancel: '取消',
  overwrite: '覆盖并创建',
  overwriting: '正在覆盖并创建…',
  createFailed: '创建 worktree 失败，请检查冲突后重试。',
  deleteWorktree: '删除 worktree',
  deleting: '正在删除…',
  deleteConfirm: '删除 worktree “{branch}”吗？这会物理删除目录及本地分支，无法恢复。',
  deleteFailed: '删除 worktree 失败。',
  branchTooltip: 'Worktree 分支：{branch}',
}

export const EN: WorktreeCopy = {
  newWorktree: 'New worktree',
  creating: 'Creating…',
  selectGitWorkspace: 'Select a Git workspace first',
  loadingBranches: 'Loading branches…',
  noBranches: 'No matching branches',
  targetBranch: 'Source branch',
  searchBranch: 'Search branches',
  targetBranchList: 'Source branch list',
  chooseTarget: 'Choose source branch',
  newBranch: 'New branch name (optional)',
  newBranchPlaceholder: 'For example feat/my-change',
  detachedHint: 'Leave blank to create a detached worktree.',
  create: 'Create worktree',
  updating: 'Updating and creating…',
  createDialog: 'New worktree',
  conflictTitle: 'Existing worktree found',
  conflictBody:
    'The directory or local branch for “{branch}” already exists. Overwriting permanently deletes the existing worktree directory and its local branch.',
  cancel: 'Cancel',
  overwrite: 'Overwrite and create',
  overwriting: 'Overwriting and creating…',
  createFailed: 'Could not create the worktree. Review the conflict and try again.',
  deleteWorktree: 'Delete worktree',
  deleting: 'Deleting…',
  deleteConfirm:
    'Delete worktree “{branch}”? Its directory and local branch will be permanently deleted.',
  deleteFailed: 'Could not delete the worktree.',
  branchTooltip: 'Worktree branch: {branch}',
}

export const DICTS = { zh: ZH, en: EN } as const
