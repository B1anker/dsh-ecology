/**
 * Check the plugins' hand-written host types against the real host packages.
 *
 * Every plugin here declares the dsh services it binds to structurally, by
 * hand (`packages/web-login/src/types.ts`, `packages/pet/src/client/host-types.ts`,
 * `packages/git-worktree/src/client-contracts.ts`, the inline `host.get<…>()`
 * shapes in world-line), because the host packages are optional peers. That is
 * the right call — see the comment at the top of each of those files — but it
 * has a cost: nothing notices when the host changes. The compatibility
 * contract is a comment, and comments do not fail builds.
 *
 * This closes the part of that gap that can be closed without a type checker:
 * for every host package a plugin binds to, find every installed copy and fail
 * loudly if a member the plugin relies on has disappeared from the host's own
 * declarations. It is a smoke check, not a type check — proving assignability
 * needs the real types in the compiler; proving a member still exists only
 * needs its declarations.
 *
 * Where the host is looked for, in order (every hit is checked, so a pinned
 * devDependency and the live host on this machine are both exercised):
 *
 *   1. the workspace root `node_modules` (CI's real-host job installs a tuple
 *      there with `bun add --no-save`);
 *   2. each workspace package's own `node_modules` (git-worktree pins
 *      `@deepseek-ai/dsh-tools` as a devDependency, for example);
 *   3. `$DSH_HOST_ROOT`, when set: a `node_modules` directory, or a directory
 *      containing one;
 *   4. the `dsh` binary on `$PATH`: its real path is followed to the
 *      `@deepseek-ai/dsh` package, whose `node_modules` carries the exact
 *      tuple that host runs.
 *
 * When nothing is found anywhere it says so and exits 0: a checkout without
 * DSH is normal, and this check must not be the reason it fails.
 *
 * Usage: node scripts/check-host-contract.mjs
 */

import { accessSync, constants, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What the plugins bind to, and where each requirement comes from.
 *
 * Every entry here is load-bearing: a member listed below is one some plugin
 * reads or replaces at runtime.
 */
const CONTRACT = [
  {
    package: '@deepseek-ai/dsh-host-webserver',
    members: ['register', 'registerUpgrade', 'registerFallback'],
    why: 'web-login wraps all three registry members to guard routes registered after it loads; pet, git-worktree, and world-line register routes through the same registry',
    fix: 'packages/web-login/src/types.ts, packages/plugin-testkit/src/types.ts, and the tested-version notes in web-login/README.md and SECURITY.md',
  },
  {
    package: '@deepseek-ai/cordis',
    members: ['effect', 'provide', 'get', 'set', 'on', 'waterfall'],
    why: 'disposal, the dshWebLoginReady readiness service, service lookup, and the tools/pre-execute waterfall depend on them',
    fix: 'packages/web-login/src/types.ts and packages/plugin-testkit/src/types.ts',
  },
  {
    package: '@deepseek-ai/dsh-tools',
    members: ['defineTool', 'register'],
    why: 'git-worktree imports defineTool at load time and registers its three tools through tools.register',
    fix: 'packages/git-worktree/src/index.ts (the apply signature) and its peerDependencies range',
  },
  {
    package: '@deepseek-ai/dsh-client-connection',
    members: ['requestRejection'],
    why: 'world-line consults connection.requestRejection before answering its management API',
    fix: 'packages/world-line/src/web/identifiers.ts (the ConnectionService contract behind IConnection) and packages/plugin-testkit/src/connection.ts',
  },
  // The browser-side services. The client packages ship declarations too, so
  // the same member check applies.
  //
  // The pet's live-state source has two host generations. On DSH ≤ 0.1.2 the
  // `sessions` service came from dsh-client-runtime and exposed
  // currentProvideInfo; 0.1.5 dropped that package and the member, and the
  // session controller now owns `sessions` (list + binding). Both entries
  // stay so whichever generation is installed is checked against the shape
  // the pet reads on it.
  {
    package: '@deepseek-ai/dsh-client-runtime',
    members: [
      'currentProvideInfo',
      'running',
      'runningCalls',
      'pending',
      'turnEnds',
      'lastAgentError',
    ],
    why: 'on DSH ≤ 0.1.2 the pet reads live agent state from sessions.currentProvideInfo and these ConversationSnapshot members',
    fix: 'packages/pet/src/client/host-types.ts (ConversationSnapshotSlice) and mood-source.ts (followProvideInfo)',
  },
  {
    package: '@deepseek-ai/dsh-api-session-controller',
    members: ['list', 'binding', 'current', 'running', 'promptError', 'lastAgentError'],
    why: 'on DSH 0.1.5+ the pet follows sessions.list.current to sessions.binding(id).session and reads these SessionSnapshot members',
    fix: 'packages/pet/src/client/host-types.ts (SessionSnapshotSlice, SessionListStateSlice) and mood-source.ts (followBinding)',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-settings',
    members: ['settingsScope', 'SettingsScopeBinder'],
    why: 'the pet persists its configuration through the settingsScope binder',
    fix: 'packages/pet/src/client/host-types.ts and the contract notes in its header comment',
  },
  {
    package: '@deepseek-ai/dsh-client-locale',
    members: ['register', 'bind', 'getSnapshot', 'subscribe'],
    why: 'git-worktree registers its dictionaries and binds a namespaced translate function',
    fix: 'packages/git-worktree/src/client-contracts.ts (LocaleService) and packages/plugin-testkit/src/client.ts (createMockLocale)',
  },
  {
    package: '@deepseek-ai/dsh-client-ui-workspace',
    members: ['startSession'],
    why: 'git-worktree opens a session in a freshly created worktree through uiWorkspace.startSession',
    fix: 'packages/git-worktree/src/client-contracts.ts (Services.uiWorkspace) and packages/plugin-testkit/src/client.ts (createMockUiWorkspace)',
  },
  {
    package: '@deepseek-ai/dsh-api-workspace-controller',
    members: ['list', 'create', 'delete', 'subscribe', 'getSnapshot'],
    why: 'git-worktree reads workspaces.list and creates/deletes workspaces for worktrees',
    fix: 'packages/git-worktree/src/client-contracts.ts (Services.workspaces) and packages/plugin-testkit/src/client.ts (createMockWorkspaces)',
  },
]

const require = createRequire(join(WORKSPACE, 'package.json'))

/**
 * The `@deepseek-ai/dsh` package directory behind the `dsh` binary on PATH.
 * @returns the directory, or null when no dsh is on PATH or it is not an npm install.
 */
function globalDshPackageDir() {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
      } catch {
        continue
      }
      // The bin is a symlink into the package; follow it and walk up to the
      // package root (the first ancestor whose package.json names the CLI).
      let current
      try {
        current = dirname(realpathSync(candidate))
      } catch {
        continue
      }
      for (let depth = 0; depth < 6; depth += 1) {
        try {
          const manifest = JSON.parse(readFileSyncUtf8(join(current, 'package.json')))
          if (manifest.name === '@deepseek-ai/dsh') return current
        } catch {
          // Not a package root; keep walking.
        }
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
    }
  }
  return null
}

/** Synchronous read helper kept local so the resolver above stays readable. */
function readFileSyncUtf8(path) {
  // Lazy import keeps the module's async-first style everywhere else.
  return realReadFileSync(path, 'utf8')
}
const { readFileSync: realReadFileSync } = await import('node:fs')

/**
 * Directories that may contain host packages as `<root>/<name>`.
 * @returns absolute `node_modules`-shaped directories, most specific first.
 */
async function hostRoots() {
  const roots = []
  const seen = new Set()
  const add = (dir) => {
    if (dir === null || dir === undefined) return
    const absolute = resolve(dir)
    if (seen.has(absolute)) return
    seen.add(absolute)
    roots.push(absolute)
  }

  add(join(WORKSPACE, 'node_modules'))
  for (const entry of await readdir(join(WORKSPACE, 'packages'), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory()) add(join(WORKSPACE, 'packages', entry.name, 'node_modules'))
  }

  const fromEnv = process.env.DSH_HOST_ROOT
  if (fromEnv !== undefined && fromEnv !== '') {
    add(fromEnv)
    add(join(fromEnv, 'node_modules'))
  }

  const globalDsh = globalDshPackageDir()
  if (globalDsh !== null) {
    add(join(globalDsh, 'node_modules'))
    // A hoisted global install puts the tuple beside the CLI package instead.
    add(dirname(dirname(globalDsh)))
  }
  return roots
}

/**
 * Every installed copy of a package across the roots.
 * @param name - the package name.
 * @param roots - directories from {@link hostRoots}.
 * @returns distinct real package directories.
 */
function installedCopies(name, roots) {
  const found = new Map()
  const record = (dir) => {
    let real
    try {
      real = realpathSync(dir)
    } catch {
      return
    }
    found.set(real, real)
  }
  try {
    record(dirname(require.resolve(`${name}/package.json`)))
  } catch {
    // Not resolvable from the workspace root.
  }
  for (const root of roots) {
    const candidate = join(root, ...name.split('/'))
    try {
      accessSync(join(candidate, 'package.json'), constants.R_OK)
      record(candidate)
    } catch {
      // Not here.
    }
  }
  return [...found.values()]
}

/**
 * Collect the text of every declaration file under a directory.
 * @param root - directory to walk.
 * @returns the concatenated contents.
 */
async function readDeclarations(root) {
  const parts = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        await walk(path)
      } else if (entry.name.endsWith('.d.ts')) {
        parts.push(await readFile(path, 'utf8'))
      }
    }
  }
  await walk(root)
  return parts.join('\n')
}

const roots = await hostRoots()
let checked = 0
let failed = false

for (const entry of CONTRACT) {
  const copies = installedCopies(entry.package, roots)
  if (copies.length === 0) {
    console.log(`skip  ${entry.package} is not installed anywhere; its contract was not verified`)
    continue
  }

  for (const root of copies) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const label = `${entry.package}@${manifest.version}`
    const declarations = await readDeclarations(root)
    if (declarations === '') {
      console.log(`skip  ${label} ships no declarations to read (${root})`)
      continue
    }

    checked += 1
    const missing = entry.members.filter(
      (member) => !new RegExp(`\\b${member}\\b`).test(declarations),
    )
    if (missing.length === 0) {
      console.log(`ok    ${label} declares ${entry.members.join(', ')}`)
      continue
    }

    failed = true
    console.error(
      `FAIL  ${label} no longer declares ${missing.join(', ')} (${root})\n` +
        `      ${entry.why}\n` +
        `      Update ${entry.fix}.`,
    )
  }
}

if (checked === 0) {
  console.log(
    '\nNothing to check: no host package was found in the workspace, beside a\n' +
      'package, under $DSH_HOST_ROOT, or behind a `dsh` on PATH. That is the\n' +
      'expected result in a checkout without DSH. Install `@deepseek-ai/dsh`\n' +
      'globally, or set DSH_HOST_ROOT to a node_modules holding the host tuple,\n' +
      'to make this check real.',
  )
}

process.exit(failed ? 1 : 0)
