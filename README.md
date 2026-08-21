# dsh-ecology

A bun workspace for packages that extend the [DSH](https://github.com/deepseek-ai)
surface. This project is independent software and is not affiliated with or
endorsed by DeepSeek AI.

## Packages

| Package | Version | Description |
| --- | --- | --- |
| [`@seaveyon/dsh-web-login`](packages/web-login) | `0.1.0` | Cookie-session login gate for the DSH Web surface, replacing a reverse proxy's HTTP Basic prompt with a styled sign-in page. |

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
