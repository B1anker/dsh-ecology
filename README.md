# dsh-ecology

A bun workspace for packages that extend the [DSH](https://github.com/deepseek-ai)
surface. This project is independent software and is not affiliated with or
endorsed by DeepSeek AI.

## Packages

| Package | Version | Description |
| --- | --- | --- |
| [`@seaveyon/dsh-web-login`](packages/web-login) | [![npm](https://img.shields.io/npm/v/%40seaveyon%2Fdsh-web-login.svg)](https://www.npmjs.com/package/@seaveyon/dsh-web-login) | Cookie-session login gate for the DSH Web surface, replacing a reverse proxy's HTTP Basic prompt with a styled sign-in page. |
| [`@seaveyon/dsh-plugin-testkit`](packages/plugin-testkit) | [![npm](https://img.shields.io/npm/v/%40seaveyon%2Fdsh-plugin-testkit.svg)](https://www.npmjs.com/package/@seaveyon/dsh-plugin-testkit) | Test doubles for the `webServer` registry, Cordis context events, a minimal tools pipeline, and the shell's client-side services, plus the conformance suites that keep them honest. |
| [`@seaveyon/dsh-pet`](packages/pet) | [![npm](https://img.shields.io/npm/v/%40seaveyon%2Fdsh-pet.svg)](https://www.npmjs.com/package/@seaveyon/dsh-pet) | A desktop pet for the DSH Web surface: hand-crafted sprites whose mood follows the live agent state, installable with one command. |

Each package is independently versioned and published; the workspace exists to
share one toolchain, not to release them together.

## Toolchain

The workspace configures each tool once, at the root, so a new package inherits
the same rules by being added to `packages/`.

| Concern | Tool | Configuration |
| --- | --- | --- |
| Package management | [bun](https://bun.sh) workspaces | `package.json`, `bunfig.toml` |
| Types | TypeScript, `strict` | `tsconfig.base.json` |
| Build | [rslib](https://rslib.rs) | per package, e.g. `packages/web-login/rslib.config.ts` |
| Tests | [rstest](https://rstest.rs) | per package, e.g. `packages/web-login/rstest.config.ts` |
| Lint | [oxlint](https://oxc.rs) | `.oxlintrc.json` |
| Formatting | [Biome](https://biomejs.dev) | `biome.json` |

Type checking is strict, and `tsconfig.base.json` additionally enables
`noUncheckedIndexedAccess` and `verbatimModuleSyntax`: an array index yields
`T | undefined` rather than an unchecked `T`, and type-only imports are written
as such rather than inferred, so the emitted import graph matches the source.

Builds are bundleless. Each source module becomes its own output file with its
own declaration, because the modules are separately meaningful — a reader
chasing a security question about cookie handling should land in
`dist/cookies.js`, not on a line range inside one bundle.

## Getting started

```sh
bun install
bun run check   # typecheck, lint, format, host and bundle contracts
bun run test    # builds each package, then runs its suite
```

Development needs Node `^20.19.0 || >=22.12.0`: rslib, rstest, and the rsbuild
beneath both refuse to start below that. Published packages set their own, lower
`engines.node` — that field describes what the built output needs, which is much
less than what building it does.

That gap means the test suite cannot verify the published floor: it runs under a
toolchain that will not start there. [`scripts/smoke-tarball.mjs`](scripts/smoke-tarball.mjs)
covers it instead by extracting a packed tarball into a clean temporary consumer
with no dependency install and importing it through the public package name, so
it can run on any Node a consumer might have. CI runs it on whatever
`engines.node` declares.

`bun run test` delegates to each package's own `test` script rather than running
`bun test` directly: the suites run under rstest, and bun's built-in runner would
discover the same files and fail on them in confusing ways.

## Root scripts

| Script | What it does |
| --- | --- |
| `bun run build` | rslib build in every package |
| `bun run test` | build, then rstest, in every package |
| `bun run test:coverage` | the same, with coverage collected and its thresholds enforced |
| `bun run typecheck` | `tsc --noEmit` over each package's sources and tests |
| `bun run lint` | oxlint across the workspace |
| `bun run lint:fix` | oxlint with `--fix` |
| `bun run format` | Biome, writing fixes |
| `bun run format:check` | Biome, reporting only |
| `bun run contract` | check the installed DSH host packages against the types the plugins assume |
| `bun run bundle:check` | validate the installable bundle manifest, patch shape, and preserved row dependencies |
| `bun run check` | typecheck, lint, format check, then host and bundle contracts |
| `bun run precommit` | `check`, then the full test suite |
| `bun run pack:check` | build and `npm pack --dry-run` in every package |

CI runs the same scripts in the same order on every push and pull request; see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

### Coverage

Coverage is off by default and on in CI, because collecting it costs about a
third of the run and the answer only has to be right before a merge. Each
package sets its own thresholds in its `rstest.config.ts`, and they are set just
under where the suite already sits. That is deliberate: a threshold above the
current number is a wish, and one below it is a ratchet — it fails the build when
a change removes coverage rather than when someone forgets to add it.
`packages/web-login` holds `src/cookies.ts` and `src/sessions.ts` to 100% on
their own, because a missed branch in either is a way in rather than a line of
code.

### Contract checks

A plugin here binds to two host surfaces it cannot install: the `webServer` route
registry and the Cordis plugin context. Their types are hand-written, so nothing
in a normal build notices when the host moves.

Two checks cover that. `bun run contract` inspects the DSH host packages if they
are installed in this checkout, and says so plainly when they are not.
Independently, `@seaveyon/dsh-plugin-testkit` states the registry's behaviour
once as a runnable suite, so the same assertions can be pointed at the doubles
here and at a real host adapter when one can be installed — which is what keeps
a mock from drifting into describing something that no longer exists.

## Releases

Every push to `main` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which re-runs the full gate and then hands the commits to
[semantic-release](https://semantic-release.gitbook.io/). Conventional commit
messages decide the version: a `fix:` is a patch, a `feat:` a minor, a `!` or a
`BREAKING CHANGE:` footer a major, and a commit that implies none of those
releases nothing.

Each package has its own configuration under [`release/`](release), and each is
released independently. Three things make that independence real rather than
nominal:

- **Scoped tags.** `web-login-v1.2.3`, not `v1.2.3`. semantic-release finds the
  last release by matching the tag pattern, so a tag naming another package is
  invisible — which is the behaviour wanted, and also the reason a bare `v1.2.3`
  would be a claim about every package at once.
- **Scoped commits.** [`scripts/release/scoped-commits.mjs`](scripts/release/scoped-commits.mjs)
  filters the branch down to the commits that touched the package's own
  directory before the analyzer ever sees it. Without it, a commit touching one
  package would bump the other and appear in its release notes.
- **One job, in sequence.** Releasing a package creates a commit and a tag and
  pushes them. A matrix would have each package start from the same checkout and
  the second push would be rejected, so the workflow loops inside one checkout
  and each release builds on the commit the last one made.

Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/):
the job exchanges a short-lived GitHub OIDC token for publish rights, so there is
no npm token in this repository's secrets, and each release carries provenance
linking it back to the workflow run that built it. The corollary is that the
workflow must never set `NODE_AUTH_TOKEN` — npm falls back to token auth the
moment it finds one, and the OIDC exchange silently stops happening.

The tarball reaches the registry *before* the tag and the GitHub release exist.
The order matters because only one of the two is reversible: a failed publish
leaves nothing tagged and the next run retries, while a publish that succeeded
before a later step failed is resumed only when the rebuilt tarball's SHA-512
integrity exactly matches the registry. If newer source would produce different
bytes under that already-published version, the release fails instead of
creating a misleading tag.

### Bootstrapping a new package on npm

A trusted publisher is configured on a package that already exists, so the very
first version of any package cannot come from CI. Publish it once by hand:

```sh
bun install && bun run test           # the tarball has to be built first
cd packages/<name> && npm publish --access public
```

Then tag that release and push the tag — `git tag <name>-v0.1.0`, matching the
`tagFormat` in the package's `release/<name>.config.mjs` — so the first automated
release counts commits from there. Without it semantic-release reads the
repository's whole history, finds the breaking changes in it, and concludes that
the next version is `1.0.0`.

Finally, on npmjs.com, open the package's **Settings → Trusted Publisher**,
choose GitHub Actions, and fill in the owner, the repository, and the workflow
*filename* — `publish.yml`, not its path — then allow the `npm publish` action.
The fields are case-sensitive. Renaming the workflow file later breaks
publishing until this setting is changed to match.

## Adding a package

1. Create `packages/<name>/` with a `package.json` whose `name` is scoped and
   whose `scripts` include `build`, `test`, `test:unit`, `test:coverage`,
   `typecheck`, and `pack:check` — the root scripts fan out by name, so a package
   missing one is silently skipped by that check rather than failing it.
2. Extend the shared TypeScript configuration:
   `{ "extends": "../../tsconfig.base.json" }`.
3. Add `rslib.config.ts` and `rstest.config.ts`. Copying
   `packages/web-login`'s is the intended starting point; set the coverage
   thresholds to whatever the new suite actually reaches.
4. Add `release/<name>.config.mjs` and a `release_package` line in
   [`.github/workflows/publish.yml`](.github/workflows/publish.yml). A package
   with no release configuration is built and tested by CI and never published,
   which is a quiet enough failure to be worth stating.
5. Add the package to the `engines-floor` matrix in
   [`.github/workflows/ci.yml`](.github/workflows/ci.yml), and teach
   [`scripts/smoke-tarball.mjs`](scripts/smoke-tarball.mjs) what to assert about
   its tarball. That job is the only one that tests what `engines.node`
   promises.
6. Run `bun install` at the root to link the new workspace member.

Lint and formatting need no per-package setup; they apply from the root.

## License

MIT. See [LICENSE](packages/web-login/LICENSE) for the terms as they apply to
each package.
