# @seaveyon/dsh-git-worktree

Git worktree management for DeepSeek Harness: three agent tools on the server, and a small browser bundle that groups worktrees under their repository in the workspace sidebar and lets you create, reveal, and remove them from there.

It replaces no DSH service. The bundle mounts beside the existing workspace controls and reads `uiWorkspace`, `workspaces`, `sessions`, and `locale`; the host side registers through `tools` and `webServer`.

## Tools

- `worktree_list` lists worktrees for the repository containing the active DSH session directory.
- `worktree_create` creates a new branch and sibling worktree. A branch such as `feat/login` is created at `HEAD` by default in `<repository>-worktrees/feat--login`. It rejects invalid branch names and existing destinations.
- `worktree_remove` removes the current linked worktree, deletes its directory, and deletes its local branch. The primary checkout is protected.

## Management API

The browser bundle talks to the host through `POST /api/plugins/dsh-git-worktree/{branches,create-conflict,create,remove,workspace-groups,reveal}`. Every route is registered behind the host's `connection.requestRejection` fence — the same Host/Origin check and browser authentication DSH applies to its own `/api` — because the routes run Git against a caller-supplied path. The plugin injects `connection`, so the loader never starts it on a host where that fence is unavailable.

## Composition

The server side is wired through [`@seaveyon/dsh-di`](../di). `src/services.ts` is the one place the graph is declared: the host's `tools`, `webServer` and `connection` are registered as ready instances under the identifiers in `src/host-services.ts`, and the plugin's two services — `WorktreeApi` (the fenced management routes, `@inject(IWebServer, IConnection)`) and `WorktreeTools` (the three agent tools, `@inject(ITools)`) — as recipes. `apply` builds an `InstantiationService` over that collection, mounts one effect per route so the host sees each registration by name, registers the tools, and disposes the container with the plugin.

A test that wants the real graph over doubles calls `createServices(ctx)`, `clone()`s it, and overrides an entry — or resolves a single service against `@seaveyon/dsh-plugin-testkit`'s `createMockServices()` without running `apply` at all. `test/routes.test.ts` does both.

## Install from this repository during development

Build this workspace package, then point the DSH profile dependency at its packed tarball or published version:

```sh
bun run --filter @seaveyon/dsh-git-worktree build
DSH_HOME=/path/to/instance/home dsh plugin --profile web add file:/absolute/path/to/dsh-ecology/packages/git-worktree --ignore-scripts
```

The package's `cordis.patch.yml` is the bundle layer DSH applies; it inserts one entry injecting `tools`, `webServer`, and `connection`.

## Compatibility

`@deepseek-ai/dsh-tools` is a peer in the `0.1.x` line (`>=0.1.2-rc.1 <0.2.0`); the package typechecks against the version pinned in `devDependencies`, and the repository's `scripts/check-host-contract.mjs` re-verifies every host member the hand-written contracts name (`defineTool`, `tools.register`, `webServer.register`, `connection.requestRejection`, and the client services in `src/client-contracts.ts`) against each installed host copy it can find.
