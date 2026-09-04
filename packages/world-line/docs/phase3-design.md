# WORLD-LINE Phase 3 design — browser probes & promotion

Scope (WORLD-LINE-SPEC §3/§6/§7): `lab promote <lab-id>`, `lab add --promote`,
`--restart`, `--accept-inconclusive`, the browser client-ready probe, the
promotion journal, and the lastKnownGood marker. Restore/rescue/report stay
Phase 4.

## 1. Client contract (empirically derived, 2026-09-04)

Discovery ran a real DSH 0.1.2-rc.1 boot in a temp home and drove it with
Playwright against the system Google Chrome (`channel: 'chrome'`), collecting
DOM/console/network evidence before any code was written. The settled web
shell of a healthy profile exposes:

- buttons `新会话` and `设置`, one of the empty-shell states `暂无会话` /
  `选择一个工作区开始` / `标准模式` (plus a beta-notice dialog that does not
  mask them), a `#root` mount with ≥1 child, and the boot globals
  `window.__DSH_BOOT__` (a `{rev, entries[], batches[]}` plugin client
  manifest) and `window.__DSH_BOOT_READY__` (presence only — its value type is
  not part of the contract).
- zero `console.error`, `pageerror`, or failed `/plugins|/api|/sse` requests.

These markers live in `src/host-adapters/dsh-client-0.1.x.ts`. **None of the
probes persist URLs, tokens or page content** — ports and redacted detail
only.

## 2. Probe module (`src/lab/browser.ts`)

`runClientProbe({ url, readyTimeoutMs, deps })` opens a fresh, cache-less
Playwright context, navigates once, polls the shell every 750 ms up to the
timeout, and settles 2 s after the markers appear to catch late errors. It
classifies into the §6 signal space:

| signal       | meaning                                                     |
| ------------ | ----------------------------------------------------------- |
| `ready`      | markers reached, zero page/console/request errors           |
| `fail`       | any client error, with or without markers                   |
| `inconclusive`| markers missing without errors (or probe crash)             |
| `no-browser` | no chromium/chrome executable                               |

The Playwright import is **lazy** (dynamic) and the browser is **never
downloaded**: resolution order is an injected fake → env
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` → bundled chromium → `channel: 'chrome'`.
CI has no browser: runs degrade to `no-browser` probes.

Probes run **inside `runLabTransaction`** while the lab host is still booted
(section 3b), because the client boot is only observable on a live host.
Per-run policy: plain runs skip client probes (offline-friendly, unit
determinism); promotion-bound runs opt in with `clientProbes: true`; the
run's verdict summarises whatever executed — skips are neutral, inconclusive
fails a run unless `--accept-inconclusive` demotes it to a warning (client
*failures* are never demoted). The three probe checks emitted per client run:

- `browser-boot` — a fresh context renders the shell (clientReady),
- `core-contract` — workspace/conversation/settings shell is intact,
- `candidate-contract` — candidates in this milestone declare no client
  entry, so the probe asserts core-not-degraded; entry-declared candidates
  can extend it later.

Probe records persist to `labs/<id>/probe.json` exactly like the Phase 2
probes and survive because promotion-bound runs retain the lab until promote
finishes.

## 3. Promotion (`src/lab/promote.ts`)

`runLabPromote(ctx, { labId, acceptInconclusive, restart })`:

1. **Version gate** (fail closed) + lab existence/state checks; only a
   `passed` lab of the context profile may promote.
2. **Client gate** — `classifyClientGate(probe.json records)`:
   `fail` (any client probe failed) → refuse with `VerificationError`, never
   overridable; no passed `browser-boot` evidence (absent/skip/inconclusive)
   → `inconclusive`, refuse unless `--accept-inconclusive`.
3. **Receipt conflict check** under the writer lock: the lab manifest's
   `source.receipt` must equal the current official receipt, else refuse
   (external edits happened while the lab ran).
4. **Auto pre-promote snapshot** (`snapshot create --label "pre-promote: …"`,
   its own writer lock).
5. **Swap under lock #2**: re-check receipts, then
   `transactionalReplaceFiles` swaps only the whitelist files
   (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `cordis.patch.yml`) from `labs/<id>/home/profiles/<name>` onto the
   official profile — same-filesystem staging inside the profile dir, every
   file fsynced, then a per-file rename dance with backup, then directory
   fsync. Failure mid-dance rolls already-moved files back. Lab runtime,
   logs, cookies, tokens and the lab home are never touched, and the derived
   `cordis.yml` is left for the next dsh boot to regenerate.
6. **Outside the lock** (each snapshot needs its own writer lock, and this
   process must not hold one twice): `after` snapshot, then `--restart`
   verification. The lock covers only the critical swap; the window between
   swap and after-snapshot is guarded by the next writer's own lock.
7. **Journal** (`<home>/world-line/journal.jsonl`, append-only): one entry per
   promote with ids, timestamps, receipts, snapshot ids, applied file list,
   and `outcome: committed | rolled-back`.
8. **`--restart`** (default: **no restart** of the official instance): first
   install the candidate's dependencies onto the official profile with the
   same `dsh plugin` calls the lab used (derived `node_modules` — never
   copied from the lab, and not a managed file), then boot the official
   profile and require a full client probe. Pass → the after-snapshot is
   marked `lastKnownGood` in `state.json` (`lastKnownGood.<profile>` —
   manifests are immutable, so LKG rides on the store state). Fail → atomic
   rollback to the pre-promote snapshot: stored whitelist objects are
   restored, managed files the promote introduced (e.g. a lockfile the
   candidate install created) are deleted, secret-skipped files are left in
   place; journal `rolled-back`, error surfaced (exit 1/3 semantics
   preserved; rollback itself failing reports a manual-rescue error).

CLI wiring: `lab promote <lab-id> [--accept-inconclusive] [--restart]` and
`--promote` on `lab add|update|remove|config apply`, which runs the lab with
client probes + retention and promotes only a passed run; without `--keep`
the lab is deleted after a successful promote. Exit codes follow §3:
verification refusals exit 1 (VerificationError), usage/file 2, internal 3.

## 4. Testing & evidence

- `test/unit/lab-promote.test.ts` — 10 tests: gate classification matrix,
  full promote happy path (journal/snapshots/content swap), client-fail
  refusal with `--accept-inconclusive` still refusing, inconclusive refusal
  and acceptance, receipt-drift refusal, restart-fail rollback, restart-pass
  lastKnownGood. The browser/launcher is faked end-to-end.
- `scripts/evidence-phase3.mjs` — real-host evidence against temp DSH home +
  real dsh + pnpm + real Chrome: promote happy path, `--restart` LKG, and the
  inconclusive gate (browser force-disabled) with/without
  `--accept-inconclusive`. Skips gracefully (exit 0, note) without dsh/pnpm
  (CI), degrades to gate-only assertions without Chrome. Output:
  `evidence/phase3-evidence.json`.

## 5. Explicitly out of scope (Phase 4+)

`restore`, `rescue`, `report`, `restore --promote` semantics, encrypted
vaults, candidate client-entry contract probing.
