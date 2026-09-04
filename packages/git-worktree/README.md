# @seaveyon/dsh-git-worktree

Server-only Git worktree tools for DeepSeek Harness.

It intentionally has no browser bundle and does not replace any DSH UI service. That keeps it compatible with the Web client: installation cannot register, disable, or patch `uiWorkspace`.

## Tools

- `worktree_list` lists worktrees for the repository containing the active DSH session directory.
- `worktree_create` creates a new branch and sibling worktree. A branch such as `feat/login` is created at `HEAD` by default in `<repository>-worktrees/feat--login`.

`worktree_create` rejects invalid branch names and existing destinations. It never removes worktrees or branches.

## Install from this repository during development

Build this workspace package, then point the DSH profile dependency at its packed tarball or published version. The plugin declares only the stable server-side `tools` dependency; it has no `dsh.client` section.
