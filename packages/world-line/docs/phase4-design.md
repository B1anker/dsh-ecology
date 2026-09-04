# WORLD-LINE Phase 4 design — restore, rescue, encrypted vault & diagnostic reports

Scope (WORLD-LINE-SPEC §3/§5/§7/§10/§11): `restore <id> [--promote]`,
`restore --last-known-good`, `rescue start/stop/list`, `report <lab|snapshot>`,
the AES-256-GCM secret vault (`vault/crypto.ts` + `vault/secrets/<id>.bin` +
manifest `secretsBundle`), and Time-Machine retention pruning. Phase 3
delivered promotion/journal/lastKnownGood and explicitly deferred exactly these
to Phase 4 (phase3-design.md §5).

Date: 2026-09-05 · base commit: `7be4797` (origin/main, merge of
feat/world-line-phase3) · milestone code state: Phase 0-3 merged on branch
`feat/world-line-phase4`.

Worktree status at writing time: **concurrent, uncommitted Phase 4
implementation work exists in this worktree** (`src/vault/crypto.ts`,
`src/vault/retention.ts`, `src/commands/report.ts`, cli wiring for `report`,
and `test/unit/{vault-crypto,retention,report}.test.ts`, plus the fs/paths
helpers). §3.2/§3.4/§3.5 below describe those modules **as implemented**, and
the remaining sections describe the not-yet-implemented surface (restore,
rescue, snapshot-capture wiring, prune CLI, evidence script). Keep this
document in sync if implementation diverges further.

## 1. Milestone goals & reuse map

| goal | spec anchor | primary reuse |
| --- | --- | --- |
| lab-first restore (verify only + `--promote`) | §3 archive, §7 Time Machine, §11 Phase 4 | `lab/create.ts` clone skeleton, `lab/run.ts` transaction probes, `lab/promote.ts` transaction, `lab/swap.ts`, `lab/journal.ts`, `vault/objects.ts` |
| `restore --last-known-good` | §3 | `vault/state.ts lastKnownGoodFor` |
| safe rescue profile builder | §3 diagnostic/rescue, §4.3, §11 Phase 4 | `host-adapters/dsh-0.1.x.ts` layout/template facts, `lab/gate.ts requirePnpm`, `lab/launcher.ts launchDsh`, `lab/runner.ts killTree`, `domain/composition.ts` patch parsing, compose check |
| encrypted secret vault | §5 | `domain/redaction.ts detectSecretShapes`, `domain/snapshot.ts` secret-skip records, `vault/crypto.ts` primitives (implemented), `fs/paths.ts secretsDir/secretBundlePath` |
| `report` diagnostics | §3 diagnostic/rescue | `vault/manifests.ts`, `lab/manifest.ts`, probe.json, `logs/*`, `domain/redaction.ts redactTree/redactText`, `fs/paths.ts reportsDir/reportPath` (already reserved) |
| retention prune | §7 default 20 daily 14 weekly 12; parent & lastKnownGood protection | `vault/manifests.ts listSnapshotManifests`, `fs/lock.ts acquireLock` |

Key discovery from reading the tree: the version-sensitive surface is NOT on
the `HostAdapter` object — it lives as free functions/constants in
`host-adapters/dsh-0.1.x.ts` (`dshBootArgs`, `dshDumpArgs`, `dshPluginArgs`,
`adapterDsh01x.profile` templates/contract). Phase 4 policy constants belong
there too (see §4).

## 2. CLI / UX

Remove `restore`/`rescue`/`report` from `PHASE_GATED` (cli.ts), add dispatch
cases, human renderers, help text, and exit-code branches. Existing option
parser facts that constrain us: global `--json`, `--break-stale-lock`,
`--dsh-home`, `--profile` are consumed by `parseInvocation`; command flags go
through `consumeOptions` which only supports single `string|boolean` values —
**repeatable flags (`--allow` on rescue) are not expressible** today (see §8).

### 2.1 restore

```text
dsh-world-line restore <snapshot-id>            # lab-first verify only (§7)
dsh-world-line restore --last-known-good        # resolve state.lastKnownGood[profile]
dsh-world-line restore <snapshot-id> --promote  # verify, then promote the snapshot state
dsh-world-line restore --last-known-good --promote
     [--accept-inconclusive] [--restart] [--allow-scripts] [--keep]
```

- `--last-known-good` and a positional id are mutually exclusive (usage error).
- Default flow: writer lock → **restore-lab creation** (whitelist bytes from
  the vault objects, not the live profile) → one `runLabTransaction` with an
  empty plan, `clientProbes: true` (restore is a lab: same host + browser
  verification as lab runs, §6/§7) → lab retained with state `passed|failed`,
  result prints the lab id. **Nothing is written to the official profile.**
  Failed/unknown restore never writes the official profile and never deletes
  vault history (fail closed, §7).
- `--promote`: after the same lab run passes, promote through the lab promote
  transaction mechanism (pre-promote snapshot → receipt re-check → atomic
  whitelist swap → after snapshot → journal; optional `--restart` boot +
  client probe marking the after snapshot `lastKnownGood`). Without `--keep`,
  the restore lab is deleted after a successful promote (same as
  `lab add --promote`). Verification refusal/rollback paths mirror
  `lab/promote.ts` exactly.
- A passed restore lab stays listed under `lab list` / inspectable via
  `lab inspect` / removable via `lab destroy` — restore-verify-only leaves the
  lab for the user to promote later **or** discard. `lab promote <restore-lab>`
  is deliberately allowed (same transaction machinery); see §3.1 for how the
  journal records it.
- Out-of-scope guard: the official profile directory must exist and be
  lockable (see §8 note: deleted-profile restore is refused with guidance).

### 2.2 rescue

```text
dsh-world-line rescue start [--allow <plugin>...] [--json]
dsh-world-line rescue list
dsh-world-line rescue stop <rescue-id>
```

- `rescue start` builds a **temporary safe profile** (own rescue home under
  `world-line/rescues/<id>/home`, own pnpm store, own PID/port — invariant 1)
  from the version policy core bundle set + the user's explicit `--allow`
  list, installs, boots on a random loopback port, and records probes. It
  never deletes, rewrites, or disables any official file, in particular
  `cordis.patch.yml` (acceptance 8). It takes the per-profile writer lock
  only while reading the official source files (atomic-read coherence with
  snapshot/promote writers; a live lock refuses with `LockedError`, same
  discipline as everywhere) and releases it before boot — the boot itself
  touches only the rescue home.
- Default `--allow` = none: the rescue profile loads exactly the policy core
  layer (DSH 0.1.2-rc.1 evidence premise: the official `cordis.patch.yml`
  defaults to `[]` and the ≈145 composed rows come from the `dsh-base` /
  `dsh-web-app` bundle layer, so a fresh template profile **is** the core-only
  profile; user plugin rows live only in `cordis.patch.yml`).
- Verification standard — **documented conclusion**: `rescue start`'s pass
  bar is compose/static + host boot + HTTP ready (`hostReady`); the browser
  `clientReady` gate (§4 invariant 2) is **not** a rescue pass criterion.
  Reasons: (a) §3's rescue contract defines no probe list and no pass/fail
  semantics (unlike §6 which is written for the lab lifecycle); (b) invariant
  2's force comes from §6 steps 4-6 + §7's promotion gate — the only code
  path where `clientReady` decides promotion is `classifyClientGate` over lab
  probe records; rescue makes no promotion decision and writes nothing; (c)
  rescue exists precisely for environments that may be broken — gating it on a
  browser would make rescue unavailable in the very failure it exists for.
  Mitigation: when a browser executable is available, rescue still runs the
  client probe as **diagnostic** evidence (recorded in probe.json as
  `warn/info`, never a gate), because a client fail on a *core-only* profile
  indicates damaged core bundles — valuable signal that `report` can carry.
  This is the one spec ambiguity worth a maintainer ruling (§8).
- `rescue stop <id>`: kill the recorded PID's process group (`killTree`
  semantics from runner.ts), then remove the rescue dir. `rescue list`: live
  rescues only (manifest + pid alive on this host).
- Id shape `rescue-YYYYMMDDTHHMMSSZ-<8hex>` (own namespace; `labs/` stays
  lab-only so `lab` list/destroy/reap semantics are untouched).

### 2.3 report

```text
dsh-world-line report <lab-id | snapshot-id>
```

Target dispatch by id prefix (`lab-…` / `snap-…`); implemented in
`src/commands/report.ts` (CLI-wired: help text, dispatch, `renderReport`).
Collects into sections: the lab or snapshot manifest facts, probe records,
and — labs only — the last 200 lines / 6000 chars of `logs/dsh.log` and
`logs/browser.log`, each log line through `redactText`; snapshot reports
carry manifest facts (files/roles/sha256, stored/secretSkipped markers,
receipt, derived state, unmanaged). **Corruption is recorded in `notes`, not
fatal** — a report must work on the broken state being diagnosed; only an
unknown/malformed/missing target is a usage error (exit 2). The bundle
document is `{formatVersion: 1, report: {id, createdAt, worldLineVersion,
environment, target}, notes, sections, redacted: true}` written atomically
(0600) to `world-line/reports/<report-id>.json` (ids `report-…`, generated
via `newReportId(now)`); re-runnable and idempotent (fresh id per run, no
source mutation, no lock). stdout prints only the path + one-line summary
(`renderReport`: path, target kind/id/profile, section count, note count) —
never content. `report` never fails on a failed lab (verdict lives in the
data; exit 0). See §8 note 10 for the exit-code rationale.

### 2.4 retention prune

New command recommendation: **`timeline prune`** (not `snapshot prune`, not a
top-level verb):

- the operation *is* the timeline's retention pass, sits next to the read-only
  `timeline list/show/diff` users consult to understand what would be removed,
  and mirrors the `lab` namespace where each object (snapshot id space) has
  create under `snapshot` but lifecycle ops under the *listing* command
  (`lab destroy`); `snapshot` today only has `create`, so `snapshot prune`
  reads oddly.
- spec §3 does not name a prune command at all (§7 describes the policy; §11
  puts “保留策略” under Phase 5 productization) — this is a spec-surface
  extension; see §8 conflict list.

```text
dsh-world-line timeline prune            # prints the plan, then asks y/N
dsh-world-line timeline prune --yes      # execute without prompting
dsh-world-line timeline prune --json     # never prompts: plan only unless --yes
```

Policy (implemented as the pure planner `planRetention` in
`src/vault/retention.ts`, defaults `DEFAULT_RETENTION_POLICY = {recent: 20,
daily: 14, weekly: 12}`): walking one profile's snapshots newest-first, keep
(1) the newest 20 overall, (2) the newest snapshot of each distinct **UTC
day**, up to 14 distinct days, (3) the newest snapshot of each distinct
**ISO week** (UTC, Monday-based, `isoWeekKey`), up to 12 distinct weeks. So
the policy caps *density*: one daily anchor per day for 14 days and one
weekly anchor per week for 12 weeks, never deleting a parent or protected
snapshot. `protectedIds` (caller supplies `state.lastKnownGood[profile]` and
`state.lastSnapshots[profile]` — the latter is redundant with the recent-20
rule in practice and pinned anyway as defense-in-depth) are never planned for
deletion and their recursive `parentId` chain is walked and kept too
(cross-profile references also protected by passing all profiles' state
references — cheap full scan).
Deletion removes only `vault/snapshots/<id>.json` and its
`vault/secrets/<id>.bin`; **content objects are NOT GC'd** (recommendation,
mirrored in retention.ts's own header: defer to a Phase 5 `vault gc` with its
own dry-run/`--yes` — objects are sha256-deduplicated and shared across
profiles/snapshots, so safe deletion needs a whole-vault manifest scan that
races with concurrent `snapshot create`). The CLI layer runs the plan under
the profile writer lock, prints the plan, and only deletes after explicit
confirmation (`--yes`, or an interactive y/N when not `--json`); corrupt
manifests are skipped with a warning, never deleted blindly.

## 3. Module design

### 3.1 Restore lab creation (`lab/create.ts` + new `src/commands/restore.ts`)

The restore lab is a lab whose **source is snapshot objects instead of the
live profile**. Clone flow (`createLab`, Phase 2) is parameterized:

```ts
// lab/create.ts — minimal change (optional param, back-compatible)
createLab(ctx, host, profileName, options?: {
  source?: { kind: 'restore'; snapshotId: string; manifest: SnapshotManifest }
})
```

- With `source.kind === 'restore'`: the whitelist copy loop reads bytes from
  the vault (`readObject(home, record.object)`; secret-skipped records read
  from the decrypted `secrets/<snapshotId>.bin` via `vault/crypto.ts` —
  §3.2); the derived root `cordis.yml` is still not copied (host rewrites it).
- Completeness rule (fail closed, in terms of the implemented record model):
  a snapshot is materializable iff every whitelist role record has
  `object !== null`, or `secretStored === true` (bytes recovered from the
  decrypted bundle via `vault/secrets.ts`). Records that remain
  `secretSkipped === true` — no bundle at capture time, provider `none`, or
  legacy Phase 1-3 vaults — are **not** byte-restorable: `restore` refuses
  **before creating the lab** with a `VerificationError` naming the file —
  an incomplete lab cannot certify the snapshot state (see §8 note 4).
- The lab manifest records the provenance extension (`lab/manifest.ts`):

```ts
source: {
  profileName: string
  receipt: string          // unchanged semantics: official-profile receipt at clone time
  kind?: 'profile' | 'restore'   // absent ⇒ 'profile' (back-compat)
  snapshotId?: string            // set when kind === 'restore'
}
```

Receipt anchor semantics matter: for a live lab, `source.receipt` is both
“what the lab contains” and “what the official profile was at clone time”.
For a restore lab those differ (lab content = snapshot state; official =
broken state the lab starts from). **The conflict guard in `runLabPromote`
must keep guarding “official unchanged since the lab was created”**, so
restore-lab creation still runs `analyzeProfile` on the official profile
under the writer lock and records *its* receipt in `source.receipt` — i.e.
the guard semantics are identical for both lab kinds and `runLabPromote`
needs no receipt-logic change. The `kind`/`snapshotId` marker exists so the
journal and human renderers can say “restore of snap-… onto profile web”
instead of pretending it was a candidate promotion.

`restore --promote` = `runLabPromote(ctx, { labId, acceptInconclusive,
restart })` on the just-verified restore lab (client gate reads probe.json —
the restore run must keep the lab and enable client probes, exactly like a
promotion-bound `lab` run keeps it). `--restart` re-verifies the official
boot post-swap and marks the after-snapshot `lastKnownGood` (rollback to the
pre-promote snapshot on failure — unchanged). Restart install step: restore
labs have an empty plan, so the promote `--restart` loop replays nothing and
only boots — correct, because the restore swap installs the *snapshot's own*
lockfile; the derived `node_modules` of the official profile is left to dsh
(as Phase 3 does).

Journal (lab/journal.ts): widen the entry kind and id prefix minimally —
`kind: 'promotion' | 'restore'`, add optional `snapshotId`; a restore
transaction appends `{ kind: 'restore', snapshotId, …rest identical }`
through the existing `appendJournal` (best-effort JSONL, unchanged);
`newJournalId(now, kind)` keeps the current `promote-…` default and emits
`restore-…` for restore entries. `reason` field already exists on
`PromotionJournalEntry` and stays redacted free text.

New command file `src/commands/restore.ts` (spec §9 lists it): snapshot-id
resolution (positional via `assertSnapshotId`, `--last-known-good` via
`lastKnownGoodFor`, missing LKG ⇒ FileError exit 2), version gate
(`requireKnownHost` — restore boots dsh, invariant 7 fail closed; read-only
doctor/snapshot remain the escape hatch), create + run + optional promote.

### 3.2 Encrypted vault (`src/vault/crypto.ts`, implemented)

- Bundle `vault/secrets/<snapshot-id>.bin` (paths already exist in
  fs/paths.ts). Envelope (as implemented): one cleartext JSON header line +
  concatenated per-file AES-256-GCM ciphertexts —
  `{formatVersion: 1, algorithm: 'aes-256-gcm', createdAt, files: [{name,
  size, iv, tag}]}` followed by each file's ciphertext in order (`size` =
  ciphertext byte length; `splitSecretBundle`/`decryptSecretBundle` walk the
  payload by offset, reject truncation and trailing bytes, and each
  `decryptChunk` sets the auth tag so a tampered bundle or wrong key
  throws). Constants: `SECRET_KEY_BYTES = 32`, `SECRET_IV_BYTES = 12`,
  `SECRET_TAG_BYTES = 16`, `SECRET_CIPHER = 'aes-256-gcm'` (node:crypto).
  The header never holds secret bytes; per-file random IVs mean one key is
  safe across many bundles.
- Key management behind one abstraction:

```ts
interface KeyProvider {
  readonly id: 'keychain' | 'env' | 'none'
  getOrCreateKey(): Promise<Buffer | null>   // null ⇒ skip, never plaintext
}
createKeyProvider({ env, home }): KeyProvider
```

  - Resolution (as implemented, `createKeyProvider`): (1) env override
    `WORLD_LINE_SECRET_KEY` (`SECRET_KEY_ENV`, 64 hex chars) → provider
    `'env'` — the dev/CI seam and the deterministic unit-test key path; (2)
    macOS (`darwin`) + `security` CLI → `keychainKeyProvider()` (id
    `'keychain'`); (3) anything else (non-mac, no `security`, CLI failure,
    user denial) → id `'none'` returning null — no non-secure fallback:
    provider `null` ⇒ the Phase 1 safe-skip policy (record hash + reason,
    persist nothing), never a plaintext write.
  - `keychainKeyProvider({service?, account?, binary?, key?})`: Keychain
    generic password via the `security` CLI — `find-generic-password
    -s <service> -a <account> -w`, on absence `add-generic-password … -U`
    with a fresh random 32-byte hex key; defaults service `dsh-world-line`,
    account `vault-secrets` (one machine-wide vault key — simpler than a
    per-home key and adequate for local secrets; tradeoff in §8 note 13).
    Any CLI failure resolves to `null` (safe skip), and a *corrupt* found
    value (non-empty, not 64 hex) resolves to `null` rather than rotating
    the key under previously encrypted bundles (fail closed). A fake
    `security` binary on the injected `binary` option exercises the Keychain
    adapter in unit tests without touching a real keychain.
  - `MemoryKeyProvider` (in-memory, tests) and `fakeSecurityKeyProvider`
    (keychain-shim with a fixed key) are the additional test seams.
- Capture wiring (implemented in `vault/secrets.ts` +
  `commands/snapshot.ts` + `domain/snapshot.ts`): `analyzeProfile` gained the
  optional hook `secretBytes?: (entry: {name, role, sha256, bytes}) =>
  Promise<boolean>` (return true = stored encrypted; false falls back to the
  plain skip policy); `runSnapshotCreate` resolves the provider via
  `createKeyProvider({env, home})`, and when a key exists calls the hook so
  `buildSecretBundle(key, sources)` (`vault/secrets.ts`) can encrypt each
  skipped file chunk, concatenate, and write the `.bin` atomically (0600)
  **before** the manifest, then `secretBundleFacts(bundle, entryCount)`
  supplies the digest for the manifest. `FileRecord` gains an optional
  `secretStored` marker (bytes restorable from the bundle; `object` stays
  null) and `secretSkipped` becomes false for stored files. Bundle format /
  per-chunk IV-tag details: see the envelope description above (a full
  implementation of this section lives in `src/vault/crypto.ts`).

```ts
// SnapshotManifest (domain/snapshot.ts) — always emitted by new writers
secretsBundle: null | { format: string; sha256: string
                        size: number; entryCount: number }
```

  The `.bin`'s sha256 (recorded in the manifest) is verified before decrypt
  (`vault/secrets.ts` `readSecretBundle`: missing bundle / unknown format /
  digest mismatch / GCM failure all throw `FileError` — a restore fails
  closed rather than materialize garbage); the header's per-file iv/tag then
  authenticate every chunk. Key provider unavailable ⇒ `secretsBundle: null`
  and the `secretSkipped` records + “skipped” warnings carry the degradation
  (Phase 1-3 behavior, now *explicit*). Legacy manifests simply lack the key
  (§6.1).
- Decryption (`decryptSecretBundle(key, bundle)` — implemented primitive)
  is used by restore-lab materialization only; bytes are written into the
  lab dir (0600 via `writeFileAtomic`), never into reports/stdout/diffs.
- Reuse `detectSecretShapes` (domain/redaction.ts, exported already; the
  domain/snapshot path calls it through `composition.scanFileText`) — the
  skip decision is unchanged; crypto only decides *where* the bytes go.
- Doctor/snapshot warning copy that still says “(Phase 4 crypto vault
  pending)” is updated (implemented) to describe the actual degradation
  (Keychain unavailable / skipped) or the encrypted-store success path.

### 3.3 Rescue (`src/commands/rescue.ts` + `src/lab/rescue.ts`)

Layout: `world-line/rescues/<id>/{home/,pnpm-store/,logs/,manifest.json,probe.json}`
(note: spec §5's tree shows `labs/` but not a rescues namespace — extension
flagged in §8; kept separate from `labs/` so lab lifecycle code never sees
rescues).

Policy constants live in the adapter (version-sensitive surface):

```ts
// host-adapters/dsh-0.1.x.ts (new export)
CORE_POLICY = {
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], // = TEMPLATES.web
  profileFiles: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'cordis.patch.yml'],
  // rows emitted under these bundles may never be skipped (invariant 3)
}
```

Builder output file set for `rescues/<id>/home/profiles/<name>`:
- `package.json`: official manifest parsed when possible (bundles reduced to
  the core policy intersection; `dependencies` reduced to core bundles +
  allowlisted plugins), else the adapter template default (`TEMPLATES.web`);
- `pnpm-workspace.yaml`: copied/generated from the adapter contract;
- `pnpm-lock.yaml`: copied when the official profile has one, otherwise
  generated by the install step;
- `cordis.patch.yml`: **only allowlisted user rows** — re-emit original YAML
  entries whose insert-name/id matches an `--allow <plugin>` name; every
  other user row (disables of core rows included) is dropped, which restores
  core rows to their bundle defaults (“core rows are not affected by the
  patch” because core rows never originate from patch files).
  Row-matching granularity (id vs insert name vs package) needs
  fixture-backed decisions during implementation — conservative default:
  keep a row iff any `insert` name equals the allow entry or the row `id`
  names it (see §8).
- Install: `requirePnpm` gate; per missing dependency run the same
  `dsh plugin` invocation lab/run.ts uses (`pnpmArgsFor`-style with
  `--store-dir <rescue store>`, default `--ignore-scripts`, optional
  `--allow-scripts` parity flag) or a single `pnpm install
  --frozen-lockfile` when the copied lockfile matches; allowlisted
  `file:`/`link:` plugins need their source reachable (same constraint as
  labs — flag when unreachable, refuse start).
- Boot: `launchDsh` with `dshBootArgs(profileName, 0)` against the rescue
  home (`DSH_HOME=rescues/<id>/home`); record PID + port in the rescue
  manifest on `ready`. Probes: `host-boot`, `http-ready` (required) +
  optional diagnostic `browser-boot` when a browser exists (§2.2 verdict).
  Boot/stop uses process-group teardown (runner/launcher, unchanged —
  acceptance 10 reuses this).
- Stop/list: manifest stores pid/startedAt/host; `stop` kills the group via
  the runner's kill semantics then `rm -rf` the rescue dir; `list` filters
  pids alive on this host (dead pid + leftover dir ⇒ report as stale, suggest
  `stop`).

### 3.4 Report (`src/commands/report.ts`, implemented)

Report id via `newReportId(now)` (`report-…`, journal id style); result
`{reportId, path, createdAt, target: {kind, id, profileName|null}, sections,
notes}` with `ReportSection = {title, text?|facts?}`; bundle written with
`writeFileAtomic` at 0600 under `world-line/reports/` (paths in fs/paths.ts,
`reportPath`). Section content and the corruption-in-notes policy are
described in §2.3. Note the deliberate scope: **no journal-line collection
and no redactTree-over-everything pass** — sources are already redacted at
capture time (manifest/probe facts) except log tails, which are the only
free-text inputs and pass through `redactText`; the whole-file `redactTree`
sweep remains available as a cheap defense if future sections ingest
unstructured YAML/config trees.

### 3.5 Retention (`src/vault/retention.ts`, implemented)

Pure planner over the immutable manifest list: `planRetention({snapshots,
profileName, policy?, protectedIds?}) → {keepIds, deleteIds,
protectedReasons}` with `DEFAULT_RETENTION_POLICY` and exported
`isoWeekKey` (UTC Monday-based); policy semantics per §2.4; protected ids and
their recursive `parentId` chains are never planned for deletion. `prune`
execution (manifest + secret-bundle deletion per id, under the profile
writer lock, plan-first-then-confirm) is CLI-layer work on top of this
planner and is not yet implemented.

## 4. Error & exit-code semantics

Follows spec §3 and existing taxonomy unchanged (`domain/errors.ts`):

| condition | class | code |
| --- | --- | --- |
| restore target unmaterializable / verification probe failed / promote client-gate refusal / rescue boot or install failure / restore-verify run fail | `VerificationError` (restore/rescue results carry `ok:false` like `LabActionResult` for render, CLI maps to 1) | 1 |
| unknown/unparseable dsh version for restore or rescue — `requireKnownHost` UsageError (same fail-closed shape as labs; `report` is read-only over manifests and needs no version gate) | `UsageError` | 2 |
| bad/missing snapshot or lab id, `--last-known-good` with positional id, no LKG recorded, mutual-exclusion misuse, unknown options, repeatable-`--allow` parsing | `UsageError`/`FileError` | 2 |
| corrupt vault manifest/state/object/bundle hash, illegal state transitions, journal/rollback double-failure | `InvariantError` (rollback failure wraps into “manual rescue required” like Phase 3) | 3 |

`runCli` additions: new exit-1 branches after `renderHuman` for
`restore`/`rescue start` results with `ok === false` (mirror the lab-verb
branch); `rescue list`, `rescue stop`, `timeline prune`, `report` exit 0 on
success (prune with nothing to delete exits 0 and prints “nothing to prune”).
All results ride the existing `{schemaVersion:1, command, ok, data|error}`
envelope unchanged; `command` strings: `restore`, `rescue start`, `rescue
list`, `rescue stop`, `timeline prune`, `report`.

## 5. Security boundary

- Secrets (invariant 6): encrypted-at-rest only in `vault/secrets/<id>.bin` —
  the AES-256-GCM key lives in the macOS Keychain generic-password item
  (service `dsh-world-line`, account `vault-secrets`) or, as a documented
  dev/CI override, in `$WORLD_LINE_SECRET_KEY` (in-memory only);
  memory/test providers are injection seams, never a product path; the key
  is never on disk inside world-line. Plaintext bytes exist only
  transiently in memory and in restore-lab profile files (0600, same
  exposure as a live-profile lab clone already has). stdout/reports/diffs/
  manifests stay redacted; the per-file IVs/tags authenticate each chunk and
  bundle digests are not secrets.
- Keychain-unavailable degradation is the *only* downgrade path and is
  explicit (`secretsBundle: null` + warnings); plaintext vault writes never
  happen (unchanged invariant).
- rescue never writes official profile/home/store files (invariant 1);
  restore lab runs under the per-profile writer lock with the same live-lock
  discipline; live locks are never overridden even with
  `--break-stale-lock` (acceptance 9).
- Transactional writers stay on the proven primitives
  (`writeFileAtomic`, `transactionalReplaceFiles`, process-group teardown) —
  no new write paths are invented for restore/promote.
- Object/bundle integrity: `readObject` hash-verifies; the bundle hash in the
  manifest is verified on decrypt; manifest immutability unchanged
  (collision ⇒ InvariantError).

## 6. Acceptance mapping (§10 items 7-10) & test patterns

Reusable seed pattern (the important one): `test/unit/lab-promote.test.ts`
fabricates a full lab (profile fixture + `labProfileDir` files + manifest
`state:'passed'` + probe.json) in a temp home, then drives `runLabPromote`
with injected launch/clientProbe fakes. Restore/rescue tests extend it: seed
a **vault snapshot** instead of a lab — `snapshot create` via `runCliIn`
against `writeProfile` fixtures, then mutate the official profile into the
“broken” state the restore must fix. `installFakeDsh` prints the adapter-known
version; compose dumps and boots come from `LabRunDeps`-style fakes as in
`test/unit/lab-run.test.ts` (capture fake returns `CLEAN_DUMP`-shaped dumps,
launch fake returns ready handles, `runClientProbe` fake returns
`READY_PROBES`).

| # | acceptance | where it lands |
| --- | --- | --- |
| 7 | `restore --promote` verifies the lab first; on lab-restore failure the official profile is unchanged | `test/unit/restore.test.ts`: happy path (official files become snapshot bytes, journal `kind:'restore'`, pre/after snapshots); client-fail refusal leaves official files byte-identical; rollback restores pre-promote state |
| 8 | `rescue start` does not modify the official patch, only starts a temp home/port | `test/unit/rescue.test.ts`: byte-compare official profile dir (esp. `cordis.patch.yml`) before/after; assert manifest/probes point into `rescues/<id>/home`; policy allow/drop matrix on patch rows |
| 9 | live lock never overridden; stale lock needs user confirmation | existing `fs-lock.test.ts` + new restore/rescue cases: hold a live lock, `restore --promote`/`rescue start` ⇒ `LockedError` and zero writes; stale lock without `--break-stale-lock` refuses |
| 10 | cross-platform paths, subprocess cleanup, Keychain-unavailable degradation | path assertions via `path.join` fixtures (existing convention); rescue-stop kills a grandchild process (fixture `sh -c '… & …'` shim, both POSIX group and Windows pid fallback branches exercised); crypto unit tests cover GCM round trips, tamper/wrong-key rejection, provider resolution and the Keychain adapter against a fake `security` binary (`keychainKeyProvider({binary})`, `fakeSecurityKeyProvider`, `createKeyProvider` seams) — capture-path tests add: no key service (env unset, provider `none`) ⇒ `secretsBundle:null`, no `.bin` written, skip warnings; `$WORLD_LINE_SECRET_KEY` override ⇒ bundle round trip + restore materialization |

### 6.1 Manifest / state compatibility verdict

Adding an optional `secretsBundle` to `SnapshotManifest`, optional
`source.kind`/`source.snapshotId` to `LabSource`, and a wider journal `kind`
union requires **no format-version bump**, because every existing reader is a
lenient envelope validator, not a schema checker:

- `parseSnapshotManifestText` (vault/manifests.ts) validates only
  `formatVersion ≤ 1`, `kind === 'profile-snapshot'`, `id` ↔ file name, and
  `profile.name`, then casts the rest (`manifest as SnapshotManifest`).
  Unknown/additional fields on disk are invisible to old readers. New code
  reading old manifests must treat a missing `secretsBundle` key as `null`
  (Phase 1-3 vaults have none — that *is* the “skipped, not restorable”
  state, §3.1); same for the new optional `FileRecord.secretStored` flag
  (absent ⇒ plaintext object or skipped). The TypeScript type makes
  `secretsBundle` required on new writers (`buildManifest` always emits
  `null | {…}`); runtime readers of legacy files still see `undefined`, so
  accessors normalize it to null.
- `readState` (vault/state.ts) maps only the keys it knows and ignores the
  rest, and `labManifestOf` (lab/manifest.ts) checks only `manifestVersion`
  and `state` — new `source` fields ride along under the same cast. New code
  defaults absent `kind` to `'profile'`.
- New writes must keep emitting every field old readers touch (`files`,
  `homePatch`, `profile.receipt`, `source.receipt`, `state` …); nothing
  existing changes meaning. Bump `WORLD_LINE_FORMAT_VERSION` only if a future
  phase makes a *required* field change.
- The one text surface that must be updated in place: doctor/snapshot
  warnings that promise “Phase 4 crypto vault pending” (§3.2) — copy only,
  no format impact.

Plus: the retention planner tests (`test/unit/retention.test.ts`, fabricated
`SnapshotManifest` lists) already cover recent/daily/weekly bucketing,
parent-chain and LKG protection, and cross-profile isolation; remaining
prune tests cover the CLI layer (plan printed first, `--json` never prompts,
manifest + `.bin` deletion, corrupt-manifest skip). Report tests
(`test/unit/report.test.ts`) already assert bundle writes with redacted log
tokens and corrupt-target notes; and a `scripts/evidence-phase4.mjs` real-dsh
round trip (restore verify-only, restore --promote with `--restart`, rescue
start/stop on a real temp home) skipping cleanly without dsh/pnpm/Chrome,
mirroring evidence-phase3.mjs. Package script: `test:real:phase4`.

## 7. Out of scope (Phase 4-)

- `--vendor-local-plugin` object vendoring and cross-machine restore
  (spec §5 optional; local link/file receipts keep working only while the
  source path exists).
- Object-store GC (recommended Phase 5 `vault gc`), key rotation/migration,
  passphrase-based key material, non-macOS secure keystores.
- Restore of a *deleted* profile directory (profile must exist + be lockable;
  rescue/doc guide users to re-init via `dsh plugin`).
- Restoring cookies/OAuth/tokens and the home-level patch layer beyond what
  snapshotting already covers; reports auto-retention; rescue of non-web
  profile kinds (acp/headless… — policy tables per adapter template).
- Browser gate for `rescue start` (see §2.2), any Web UI, background daemon.

## 8. 设计注意 — conflicts & open questions

1. **Spec-internal conflict: retention phase.** §7 already fixes the policy
   (“最近 20/每日 14/每周 12…清理先显示计划并确认”), but §11 puts “保留策略” under
   Phase 5 and `domain/snapshot.ts` comments say no retention exists “before
   Phase 5”. This design ships `timeline prune` in Phase 4 per the task
   scope; flag for spec revision (which phase owns it, and add the command to
   §3's CLI contract).
2. **Invariant 2 (browser) × rescue**: §4.2 reads globally, yet §3 defines no
   rescue verification contract and §6/§7 scope `clientReady` to lab
   verification/promotion. Conclusion in §2.2: rescue's gate is host+HTTP,
   browser stays a diagnostic. Needs a maintainer ruling or spec wording
   (“验证必含浏览器” applies to candidate/restore acceptance, not rescue
   bootstrap).
3. **Restore-lab receipt semantics** are the deepest reuse trap: the promote
   conflict guard must compare against the official receipt *at restore-lab
   creation*, not against the snapshot receipt (they differ whenever a
   restore is meaningful). If an implementer naively sets
   `source.receipt = snapshot.profile.receipt.tree`, every restore-promote
   would falsely report a receipt conflict or, worse, skip the guard. The
   `kind:'restore'` marker + documented anchor rule in §3.1 exist to prevent
   this; enforce with a unit test that mutates the official profile between
   restore-lab creation and promote and expects refusal.
4. **Secret-skip × restorability**: snapshots from Phases 1-3 carry no
   `secretsBundle`; any of them that secret-skipped a whitelist file are not
   byte-restorable. Fail-closed completeness rule (§3.1) means those restore
   attempts refuse cleanly instead of silently producing a lab whose
   verification certifies an incomplete state. Side effect worth stating:
   after Phase 4, users who want restorable secrets must re-snapshot with a
   working Keychain.
5. **`analyzeProfile` hook asymmetry**: the capture store hook never receives
   skipped bytes, so crypto capture needs the new `secretBytes` hook — a
   caller-shape change for `analyzeProfile` (optional, so doctor/createLab
   are untouched).
6. **Rescue surface is under-specified by the spec**: no directory namespace
   (§5 tree lacks rescues), no rescue-specific probes, no `list` command
   (§3 lists only start/stop), no definition of what `--allow` matches
   (plugin package vs row id vs insert name). Design choices in §2.2/§3.3
   are proposals; the `--allow` row-matching rule and the writer-lock scope
   (held only while reading the official source, released before boot —
   §2.2) should be validated against real patch fixtures.
7. **Compose parser drops bundle attribution**: `parseComposedTreeText`/
   `collectRows` flatten rows and discard the `# == <bundle>` section
   markers, so a *static* “all core rows present” assertion (invariant 3 for
   rescue) cannot be implemented without extending `ComposedRow` with its
   bundle of origin. Evidence-driven alternative used here: compare the
   rescue dump against a pristine template dump (`dsh --dump-config`
   initializes missing profiles — documented evidence), which sidesteps
   hardcoding the ~145-row core set. Either way the bundle-attribution
   extension is a small, optional improvement.
8. **CLI parser**: `consumeOptions` supports only single string/bool values,
   so `rescue start --allow a --allow b` needs either a repeatable-flag
   extension (record → `string[]` when the option declares `'list'`) or
   comma-separated `--allow a,b`; also `--last-known-good`/`--promote`/
   `--accept-inconclusive`/`--restart`/`--keep`/`--allow-scripts` are plain
   boolean additions per command table. `rescue start` under `--json` must be
   non-interactive (no prompt — decided: no prompts exist in this codebase;
   keep it that way).
9. **Restore installs need pnpm/network**: restore-lab boot requires a real
   dependency install when the snapshot references registry packages
   (`pnpm install --frozen-lockfile` into the lab store, `--ignore-scripts`
   default with `--allow-scripts` parity). Whether core bundles can boot from
   dsh's global fallback resolution (evidence says `--dump-config` can)
   needs a real-boot evidence check during Phase 4 implementation; if boot
   works pre-install, install may be skipped for core-only restores.
10. **Report exit code choice** (“verification failure” vs “ok”): reports of
    failed labs exit 0 with the failure in data — deviation from “验证不通
    过退出码 1” is intentional (report is not a verification step) but should
    be acknowledged in help text.
11. **Restore-lab retention**: passed restore labs currently fall under the
    generic lab manifest retention (`delete-on-success` default is inverted
    for restore — restore always retains). Failed restore labs keep 7 days
    via the existing reap; passed restore labs persist until `lab destroy`
    — an explicit UX note in `restore` output is required to avoid vault
    growth; alternatively accept a `--no-keep` later (out of scope).
12. **Manifest `validation`/`retention` nulls** (reserved by Phase 1 for
    later phases): a verified restore could record `validation` facts on the
    *after* snapshot; this design keeps snapshot manifests untouched (they
    are immutable) and lets lab manifests + journal carry the evidence —
    consistent with Phase 3's decision to ride LKG on `state.json`.
13. **Machine-wide Keychain item** (service `dsh-world-line`, account
    `vault-secrets`): one key protects every home's bundles on this machine.
    Tradeoffs: (a) per-home accounts were considered and rejected — a single
    item is one secret to protect, and the macOS login keychain is
    per-user anyway; (b) clearing the item, migrating the vault to another
    machine, or losing the keychain makes every bundle undecryptable —
    restore then fails closed via the completeness rule (never a plaintext
    downgrade); the recovery guidance is “re-snapshot the live profile with
    a working key service”; key rotation/migration is explicitly out of
    scope (§7).

## 9. Deliverable summary

Implemented at writing time (concurrent worktree state, see header note):
`src/vault/crypto.ts`, `src/vault/secrets.ts`, `src/vault/retention.ts`,
`src/commands/report.ts`, the snapshot-capture crypto wiring
(`commands/snapshot.ts` + `domain/snapshot.ts` `secretBytes` hook +
`FileRecord.secretStored` + `SnapshotManifest.secretsBundle` + doctor copy),
cli.ts help/dispatch/render for `report`, fs/paths helpers — with
`test/unit/{vault-crypto,retention,report}.test.ts` (plus
`vault-snapshot.test.ts` manifest fixtures updated).

Remaining new source: `src/commands/restore.ts`, `src/commands/rescue.ts`,
`src/lab/rescue.ts`; extensions to `cli.ts` (restore/rescue/prune dispatch +
render + exit branches), `lab/create.ts` (restore source), `lab/manifest.ts`
(`source.kind`/`snapshotId`), `lab/journal.ts` (kind `'restore'` +
snapshotId), `host-adapters/dsh-0.1.x.ts` (`CORE_POLICY`),
`commands/timeline.ts` (`prune` CLI), `index.ts` (exports), `package.json`
(`test:real:phase4`), `scripts/evidence-phase4.mjs`, and
`test/unit/{restore,rescue}.test.ts` plus the prune-CLI layer tests. No
Phase 1-3 reader needs a format bump (§6.1 — manifest parsers validate
envelope only and tolerate unknown fields; new code treats missing
`secretsBundle`/`source.kind` as `null`/`'profile'`).
