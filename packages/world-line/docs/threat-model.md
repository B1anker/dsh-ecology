# Threat model — Phase 0/1 read-only surface

Scope: the `dsh-world-line` CLI as shipped in this milestone (doctor,
snapshot, timeline; vault + locks underneath). Restore/lab/rescue and the
crypto vault are later phases; where a risk only materializes there, it is
named as such so the design already carries the seam.

## Assets

1. **Profile composition state** (manifest, patch layer, workspace, lockfile,
   local-plugin receipts) — the data snapshots must not falsify.
2. **Vault integrity** — objects, manifests, and state that later phases will
   restore *from*.
3. **Secrets** embedded in profile files (API keys, tokens, URL credentials,
   webhook URLs) — must never appear in stdout, transcripts, manifests, diffs,
   doctor details, or the plaintext vault.
4. **User working state** — live profiles must never be modified by this
   milestone.

## Trust boundaries

- **Trusted**: the user running the CLI; the files inside the chosen DSH home;
  content hashes (sha256) as integrity anchors.
- **Untrusted by default**: anything a *profile file contains* (it is YAML a
  plugin ecosystem wrote — keys, strings, `!!js` scalars are data); the vault
  directory of a home world-line does not own (local corruption or tampering);
  error strings from files and processes.

## Threats and mitigations

| # | threat | mitigation | residual risk |
| --- | --- | --- | --- |
| T1 | A secret in a profile file leaks into output or manifests | key-name and shape redaction at every text/tree boundary (invariant 6); files whose *content* trips the detector are never stored (hash + skip reason); evidence asserts stdout/vault cleanliness with an injected `sk-` value | shape detector is pattern-conservative by design; unknown secret formats inside an allowed file still end up in the plaintext vault until Phase 4 — noted in doctor (`secret-files` is `info`) |
| T2 | Vault files tampered or truncated (bit rot, rogue process) | objects are content-addressed and hash-verified on read; manifest read validates envelope (format ≤ current, kind, id↔filename); writes are atomic + fsynced | corruption in *unread* snapshots is only detected at read time; `timeline list` reports them as `corrupt` |
| T3 | Manifest id collision or rewrite after the fact | immutable writes: O_EXCL existence probe + atomic rename; collision ⇒ `E_INTERNAL` | — |
| T4 | Two writers race on one profile | exclusive O_EXCL lock per `{dshHome, profile}`; live lock never broken even with `--break-stale-lock`; stale locks require the flag; token-checked release can't delete a successor's lock | lock relies on pid liveness; pid reuse by an unrelated process is indistinguishable (rare, stale-by-host+age refinement is Phase 4) |
| T5 | `cordis.yml` (derived, boot-rewritten) is snapshotted or restored as if authored | whitelist excludes it; only presence + template-cleanliness recorded; diff reports derived-state change separately | a *future* restore phase must regenerate it by boot, never by file copy |
| T6 | `node_modules` or arbitrary profile content is recursed/copied | capture whitelist is fixed and flat; unknown extra top-level files are listed `unmanaged`, never stored | future restore must refuse dropping `unmanaged` files (planner seam exists) |
| T7 | A malicious profile (e.g. from an untrusted bundle) exfiltrates via `!!js` patch scalars | world-line parses with the JSON schema + `!!js` construct tag; the payload is stored as inert `{__jsExpr}` text, never evaluated | real `dsh` boot does evaluate it — outside world-line's control and outside this milestone's tooling |
| T8 | Symlink/profile-name tricks escape the home | profile names validated against `""` `.` `..` `node_modules`, separators, NUL; scanning never follows into directories | link:/file: dependency targets are deliberately *read outside* the home for receipts (their own directories are the plugin's trust domain) |
| T9 | Errors leak file contents or secret-shaped values | every user-facing error passes `redactText`; doctor details are re-redacted at render | — |
| T10 | A stale/corrupt lock file bricks future snapshots | corrupt lock files are treated as stale-but-never-auto-removed; refusal messages name the path and the `--break-stale-lock` escape | — |
| T11 | Home moves between machines; snapshots misattributed | host + receipt travel in the manifest; `parentId` chaining is home-scoped; no cross-home assumptions | — |
| T12 | Unknown future DSH writes a different profile shape | adapter contract pins filenames/template/templates per exercised version; unknown versions stay read-only-with-warnings | adapter set must grow with real evidence before guesswork phases ship |

## Invariants this milestone enforces in code

1. Never write into a profile directory (`world-line/` siblings live under
   the home, not under `profiles/`).
2. Every vault mutation is atomic (temp + fsync + rename) with mode 0600.
3. Content-addressed objects are immutable and verified on read.
4. Manifests are immutable; collision ⇒ internal error.
5. Lock release is token-checked; live locks are never broken.
6. Secrets never reach stdout/manifests/diffs/plaintext vault (doctor
   `secret-files` check reports policy compliance).
7. Version-sensitive behavior is gated on the exercised-version evidence set.

## Not in scope (later phases must address)

Encryption at rest and key management (Phase 4), restore-time re-application
semantics and conflict handling, multi-home sync, report generation, and any
behavior that evaluates patch expressions.
