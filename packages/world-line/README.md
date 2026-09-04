# @seaveyon/dsh-world-line

A read-only time machine and doctor for DSH profiles: capture the exact
composition state of a DSH profile (manifest, patch layer, workspace and
lockfile, local-plugin receipts), keep it in an append-only content-addressed
vault, and diff any two captures — **Phase 0/1 of the WORLD-LINE-SPEC**.

This milestone deliberately ships no mutation of profiles and no UI: no
restore, no promotion, no browser probing. Read the spec for the roadmap and
the exact acceptance evidence (`docs/compatibility.md`, `docs/threat-model.md`,
`evidence/live-evidence.json`).

## Install / run

```sh
# from this repo (bun workspace)
bun install
bun run --filter @seaveyon/dsh-world-line test:unit

# from the package directory: build, test, verify against a real dsh (if on PATH)
bun test:real
```

The shipped artifact is a plain Node CLI (requires Node >= 22; the CI matrix
also runs 20.19 and 22.12/24 suites):

```sh
dsh-world-line [--dsh-home <path>] [--profile <name>] <command> [--json]
```

`--dsh-home` defaults to `$DSH_HOME` then `~/.dsh`; the default profile is
`web` — nothing here is hardcoded, and nothing writes into a live profile.

## Commands (this milestone)

| command | purpose |
| --- | --- |
| `doctor` | read-only diagnostics over the host + profile + vault; exit 1 when a check fails |
| `snapshot create [--label t] [--break-stale-lock]` | capture the profile into the vault (content-addressed objects + immutable manifest) |
| `timeline list` | snapshots of the current profile, newest first |
| `timeline show <id>` | one manifest (default: latest) |
| `timeline diff <a> <b>` | semantic diff: files, bundles, dependencies, patch entries per layer, derived root, unmanaged files |

`lab`, `restore`, `rescue`, `report` are recognized and refused with their
roadmap phase until the spec's later phases ship.

`-h/--help` prints usage; `-V/--version` prints the package version.

Every command answers `--json` with a `{schemaVersion: 1, command, ok,
data|error}` envelope. Exit codes: `0` ok · `1` verification failed ·
`2` usage/file error · `3` internal invariant error.

## What a snapshot contains

- **Files** (`manifest` = package.json, `profile-patch` = cordis.patch.yml,
  `workspace` = pnpm-workspace.yaml, `lockfile` = pnpm-lock.yaml when present)
  stored by sha256 into `world-line/vault/objects/`.
- **Receipt**: per-file sha256 plus a canonical tree hash over the same set.
- **Derived state**: `cordis.yml` presence and cleanliness against the exact
  boot template of the exercised DSH (it is rewritten on every boot — it is
  *never* snapshotted).
- **Dependencies**: registry/link/file/git/tarball classification, resolved
  versions from the lockfile, and content receipts for local link/file
  plugins (`package.json` + `cordis.patch.yml`, plus git HEAD when the target
  is a checkout).
- **Redaction (invariant 6)**: values under sensitive key names and
  recognizable token/URL/bearer shapes are stored as `<redacted>`; a managed
  file that *carries* secret-shaped content is never persisted to the
  plaintext vault — its hash is recorded with a skip reason (the encrypted
  vault arrives in Phase 4).

`cordis.yml`, `node_modules`, and anything the whitelist does not name are
never captured; unknown extra top-level files are reported as `unmanaged` so
a future restore planner can refuse to drop them silently.

## Locks

One writer per `{dshHome, profile}` (`world-line/locks/<profile>.lock`). A
live lock is never overridden, even with `--break-stale-lock`; a stale lock
(dead holder or foreign host) is refused unless that flag confirms the break.
`timeline` and `doctor` need no lock.

## Layout

```
<DSH_HOME>/world-line/
  state.json            # profile -> latest snapshot id
  locks/<profile>.lock  # writer lock
  vault/
    objects/<sha256>    # immutable content-addressed files
    snapshots/<id>.json # immutable manifests (collision => invariant error)
  labs/                 # Phase 2+
  reports/              # Phase 4+
```

Manifest/format identity: `formatVersion 1` · envelope `schemaVersion 1` ·
package version 0.1.0. Snapshot ids are `snap-YYYYMMDDTHHMMSSZ-<8 hex>`.

## Development

```sh
bun run build       # tsc NodeNext -> dist/
bun test:unit       # rstest, fixture DSH homes only (no real dsh needed)
bun test:coverage   # v8 coverage with ratchet thresholds
bun test:real       # live evidence against a real `dsh` on PATH (skips cleanly otherwise)
bunx tsc -p tsconfig.json --noEmit
```

Tests build real profile layouts in temp DSH homes; none of them touch
`~/.dsh`.
