# dsh-ecology

A bun workspace for packages that extend the [DSH](https://github.com/deepseek-ai)
surface. This project is independent software and is not affiliated with or
endorsed by DeepSeek AI.

## Packages

| Package | Version | Description |
| --- | --- | --- |
| [`@seaveyon/dsh-web-login`](packages/web-login) | [![npm](https://img.shields.io/npm/v/%40seaveyon%2Fdsh-web-login.svg)](https://www.npmjs.com/package/@seaveyon/dsh-web-login) | Cookie-session login gate for the DSH Web surface, replacing a reverse proxy's HTTP Basic prompt with a styled sign-in page. |

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
bun run check   # typecheck, lint, format
bun run test    # builds each package, then runs its suite
```

Development needs Node `^20.19.0 || >=22.12.0`: rslib, rstest, and the rsbuild
beneath both refuse to start below that. Published packages set their own, lower
`engines.node` — that field describes what the built output needs, which is much
less than what building it does.

That gap means the test suite cannot verify the published floor: it runs under a
toolchain that will not start there. [`scripts/smoke-tarball.mjs`](scripts/smoke-tarball.mjs)
covers it instead by extracting a packed tarball somewhere with no `node_modules`
and importing it, so it can run on any Node a consumer might have. CI runs it on
whatever `engines.node` declares.

`bun run test` delegates to each package's own `test` script rather than running
`bun test` directly: the suites run under rstest, and bun's built-in runner would
discover the same files and fail on them in confusing ways.

## Root scripts

| Script | What it does |
| --- | --- |
| `bun run build` | rslib build in every package |
| `bun run test` | build, then rstest, in every package |
| `bun run typecheck` | `tsc --noEmit` over each package's sources and tests |
| `bun run lint` | oxlint across the workspace |
| `bun run lint:fix` | oxlint with `--fix` |
| `bun run format` | Biome, writing fixes |
| `bun run format:check` | Biome, reporting only |
| `bun run check` | typecheck, then lint, then format check |
| `bun run precommit` | `check`, then the full test suite |
| `bun run pack:check` | build and `npm pack --dry-run` in every package |

CI runs the same scripts in the same order on every push and pull request; see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Releases

Every push to `main` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which re-runs the full gate and then hands the commits to
[semantic-release](https://semantic-release.gitbook.io/). Conventional commit
messages decide the version: a `fix:` is a patch, a `feat:` a minor, a `!` or a
`BREAKING CHANGE:` footer a major, and a commit that implies none of those
releases nothing. Configuration is in [`.releaserc.json`](.releaserc.json).

Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/):
the job exchanges a short-lived GitHub OIDC token for publish rights, so there is
no npm token in this repository's secrets, and each release carries provenance
linking it back to the workflow run that built it. The corollary is that the
workflow must never set `NODE_AUTH_TOKEN` — npm falls back to token auth the
moment it finds one, and the OIDC exchange silently stops happening.

The tarball reaches the registry *before* the tag and the GitHub release exist.
The order matters because only one of the two is reversible: a failed publish
leaves nothing tagged and the next run retries, while a publish that succeeded
before a later step failed is skipped on the re-run by an `npm view` check,
rather than leaving a tag that claims a version the registry never received.

Tags are `web-login-v<version>`, scoped to the package rather than the
repository, because the packages here are versioned independently. That the
analyzer still reads *every* commit on `main` is a limitation worth knowing
about before a second package ships: at that point each package needs its own
semantic-release configuration and commit filter.

### Bootstrapping a new package on npm

A trusted publisher is configured on a package that already exists, so the very
first version of any package cannot come from CI. Publish it once by hand:

```sh
bun install && bun run test           # the tarball has to be built first
cd packages/web-login && npm publish --access public
```

Then tag that release and push the tag — `git tag web-login-v0.1.0` — so the
first automated release counts commits from there. Without it semantic-release
reads the repository's whole history, finds the breaking changes in it, and
concludes that the next version is `1.0.0`.

Finally, on npmjs.com, open the package's **Settings → Trusted Publisher**,
choose GitHub Actions, and fill in the owner, the repository, and the workflow
*filename* — `publish.yml`, not its path — then allow the `npm publish` action.
The fields are case-sensitive. Renaming the workflow file later breaks
publishing until this setting is changed to match.

## Adding a package

1. Create `packages/<name>/` with a `package.json` whose `name` is scoped and
   whose `scripts` include `build`, `test`, `typecheck`, and `pack:check` — the
   root scripts fan out by name, so a package missing one is silently skipped by
   that check.
2. Extend the shared TypeScript configuration:
   `{ "extends": "../../tsconfig.base.json" }`.
3. Add `rslib.config.ts` and `rstest.config.ts`. Copying
   `packages/web-login`'s is the intended starting point.
4. Run `bun install` at the root to link the new workspace member.

Lint and formatting need no per-package setup; they apply from the root.

## License

MIT. See [LICENSE](packages/web-login/LICENSE) for the terms as they apply to
each package.
