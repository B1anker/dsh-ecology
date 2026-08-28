# dsh-web-login

[English](README.md) · [简体中文](README.zh-CN.md)

A cookie-session login gate for the DSH Web surface. It replaces a reverse
proxy's browser-native HTTP Basic prompt with a small self-contained sign-in
page while protecting the Web UI, API routes, plugin assets, the SPA fallback,
and WebSocket upgrades.

> **Status:** published on npm. Requires Node.js **20.11.0 or later**. This
> project is independent software and is not affiliated with or endorsed by
> DeepSeek AI.

## What it does

- reads an scrypt password verifier from an environment variable, never from
  plugin configuration;
- creates opaque, random in-memory sessions behind a host-only `HttpOnly`,
  `SameSite=Strict` cookie, named with the `__Host-` prefix wherever TLS makes
  that possible;
- redirects browser document navigations to `/login`, while API, plugin, and
  other resource routes get a machine-readable `401` instead of an HTML login
  page;
- requires `POST /logout` and invalidates both the server session and browser
  cookie;
- protects routes registered through the DSH `webServer` registry, including
  exact routes, prefix routes, SPA fallback, and WebSocket upgrades;
- limits failed password attempts **before** scrypt runs — per network and
  across all of them — with bounded memory for limiter state and sessions, and
  refuses rather than admits when either bound is reached;
- derives scrypt off the event loop under a bounded concurrency gate, so a flood
  of sign-ins cannot stall the rest of the DSH process; and
- sends `Cache-Control: no-store`, CSP, anti-framing, no-sniff, and no-referrer
  headers on all pre-authentication responses.

Sessions are intentionally process-local: restarting DSH signs every visitor
out. That avoids persistent session keys and a session database, but this is
not a shared-session solution for multiple DSH instances.

## Before you install

1. Put the DSH Web service behind HTTPS in production. `secureCookie` is `true`
   by default and should stay enabled when TLS terminates at a reverse proxy.
2. Ensure that the proxy-to-DSH hop is private or otherwise protected. This
   package does not replace a firewall, private listener, TLS, or proxy access
   policy.
3. Keep the DSH environment file private. It holds a password *verifier*, which
   is still credential material. Do not commit it, paste it into logs, or put it
   in a profile manifest.
4. Install this package as a DSH bundle, not as an ordinary dependency. Its
   bundle layer adds the readiness injection every shipped Web route owner needs;
   without those injections, a row can register routes before the gate decorates
   the registry.

For the full security model and reporting path, see
[`SECURITY.md`](SECURITY.md).

## Install

Add the bundle to the DSH Web profile:

```sh
dsh plugin --profile web add @seaveyon/dsh-web-login
```

The package declares `dsh.bundle.patch`, so `dsh plugin` both installs the npm
dependency and appends its [`cordis.patch.yml`](cordis.patch.yml) layer to the
profile. That layer inserts the login plugin and makes `web-runtime`,
`connection`, `modules`, and `client-hmr` wait for `dshWebLoginReady`; its
`inject` arrays restate `webStartup` and `webRuntime` because DSH patch fields
replace complete values rather than appending to them.

The package declares the DSH host and Cordis packages as optional peers because
a normal DSH Web installation already provides them.

Generate a verifier from an interactive terminal (the password is not echoed):

```sh
dsh plugin --profile web exec dsh-web-login-hash
```

The command writes `LOGIN_PASSWORD_HASH=scrypt$…` into `${DSH_HOME}/.env` when
`DSH_HOME` is set, otherwise `~/.dsh/.env`. It preserves unrelated assignments,
uses an atomic replacement, and sets the result to mode `0600`. It deliberately
prints neither the password nor the verifier. The DSH home directory must exist
before running the command. Replace `web` when the bundle is installed in a
differently named profile.

If DSH is launched by a service manager, make sure that process actually loads
that environment file. The plugin fails closed at startup if the configured
verifier is absent or malformed.

Before starting the profile, inspect the composed tree:

```sh
dsh --profile web --dump-config
```

The dump must contain the `dsh-web-login` row and all four readiness injections
described above. An unmatched-row warning means the installed DSH Web
composition has moved and must be treated as incompatible, not ignored.

Restart DSH after changing the bundle or environment. A document
navigation to `/` should redirect to `/login`; sign in, then confirm the Web
UI, API, plugin assets, and WebSocket-backed features work. In a private or
incognito window, confirm that direct API and WebSocket requests are denied.

Later profile settings override the bundle row by id. For example, plain-HTTP
loopback development needs the weaker non-Secure cookie:

```yaml
- id: dsh-web-login
  config:
    secureCookie: false
    title: DSH Web
```

DSH replaces the row's complete `config` with this mapping; omitted plugin
settings still receive this package's validated defaults.

## Configuration

All configuration is validated. Unknown or misspelled keys stop startup instead
of silently selecting an unsafe default.

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `passwordHashEnv` | `LOGIN_PASSWORD_HASH` | env-name syntax | Name of the environment variable holding `scrypt$<salt hex>$<key hex>`. |
| `title` | `DSH Web` | 1–120 characters | Login-page and browser-title text. |
| `secureCookie` | `true` | — | Adds the `Secure` attribute and the `__Host-` cookie name. Keep it enabled outside localhost HTTP development. |
| `sessionTtlMs` | 30 days | 1 minute–365 days | Session lifetime; a restart always signs users out sooner. |
| `maxSessions` | `10000` | 1–1000000 | Maximum live sessions. At capacity a new login receives `503`; live sessions are never evicted. |
| `maxBodyBytes` | `4096` | 64 B–1 MiB | Maximum accepted login form body. |
| `sweepIntervalMs` | 5 minutes | 1 second–1 hour | Interval for removing expired session and limiter records. |

#### Password-attempt limiting

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `attemptLimit` | `5` | 1–1000 | Failed attempts in a window before blocking that client. |
| `attemptWindowMs` | 15 minutes | 1 second–24 hours | Failure-counting window. |
| `blockMs` | 15 minutes | 1 second–24 hours | Duration of a per-client block. |
| `maxAttemptClients` | `10000` | 1–1000000 | Maximum limiter records. At capacity, a client with no record is refused rather than admitted untracked. |
| `globalAttemptLimit` | `100` | 1–1000000 | Failures across *all* clients in one window before every sign-in is blocked. |
| `globalBlockMs` | 1 minute | 1 second–24 hours | Duration of a global block. Much shorter than `blockMs`, because this one can also catch the operator. |
| `ipv4PrefixBits` | `32` | 8–32 | Network width an IPv4 client is counted under. |
| `ipv6PrefixBits` | `64` | 32–128 | Network width an IPv6 client is counted under. |

#### Password hashing

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `kdfConcurrency` | `2` | 1–32 | scrypt derivations allowed to run at once. |
| `kdfQueueDepth` | `8` | 0–1024 | Sign-ins allowed to wait for a slot. Beyond it, a sign-in is refused with `503` and `Retry-After` rather than queued. |

### Password hashing and the event loop

scrypt costs roughly 80 ms and 16 MiB per derivation, and an unauthenticated
caller chooses when it happens. The plugin runs it on libuv's threadpool rather
than synchronously — a synchronous derivation holds the event loop, so it would
stall every other request, WebSocket frame, and timer in the DSH process, not
just the sign-in that caused it.

That moves the problem rather than solving it: the threadpool has four slots by
default, and filling all of them starves the file and DNS work the rest of DSH
does. `kdfConcurrency` bounds how many the gate will occupy, and `kdfQueueDepth`
bounds how many callers may wait. Past both, a sign-in is refused immediately
with a `503` and a `Retry-After`, which is a worse experience for one visitor and
the only outcome that keeps the process responsive under a flood.

### Rate limiting

Failures are counted per client and, independently, across all clients. The
per-client counter is the one that stops a guessing attack from one address; the
global budget is the backstop for the same attacker spread over many, which
per-client counting cannot see by construction.

A client is a *network*, not an address. Counting single addresses is not
throttling anyone who holds an IPv6 /64 — that is eighteen quintillion
independent allowances — so addresses are masked to `ipv4PrefixBits` and
`ipv6PrefixBits` before they become limiter keys. Anything that is not an address
at all collapses to one shared bucket, so an attacker-chosen header cannot mint
new identities.

When the limiter table is full at `maxAttemptClients`, a client with no existing
record is refused rather than admitted untracked. The alternative fails open: the
table fills, and every new client is then unlimited, which is exactly the state
an attacker would engineer.

### Trusted proxies and the limiter

With the default `trustProxy: false`, throttling uses the direct socket address,
which clients cannot forge. Enable `trustProxy` **only** if DSH is unreachable
except through a trusted proxy that overwrites the forwarded-IP header on every
request. The plugin uses the final comma-separated hop, because that is the one
the proxy appended after seeing its peer.

```yaml
- id: dsh-web-login
  config:
    trustProxy: true
    clientIpHeader: x-forwarded-for
```

| Key | Default | Meaning |
| --- | --- | --- |
| `trustProxy` | `false` | Use a forwarded client-IP header for throttling. |
| `clientIpHeader` | `x-forwarded-for` | Header name, lower-cased, read only when `trustProxy` is true. |

A proxy that merely passes through an incoming `X-Forwarded-For` header lets
clients create arbitrary limiter identities and defeats per-client throttling.

### The session cookie

Under `secureCookie: true` the cookie is named `__Host-dsh_session`. The prefix
is not decoration: a browser refuses to accept a `__Host-` cookie unless it is
`Secure`, has `Path=/`, and carries no `Domain`, and those three conditions
cannot be met by a sibling subdomain setting a cookie for the parent domain. It
is what makes "this cookie came from this host" something the browser enforces
rather than something this code merely refrains from widening.

The prefix requires `Secure`, so it is unavailable under `secureCookie: false`.
That configuration exists for plain-HTTP loopback development and gets the
unprefixed name.

Where a name does arrive twice with different values, the request is treated as
unauthenticated rather than resolved in either direction. The Cookie header
carries only names and values, so a cookie planted from a wider scope is
indistinguishable here from the real one — and browsers order cookies by
descending path length, which means "take the first" selects exactly the value it
was meant to exclude. Logging out clears both cookie names, so a deployment that
has upgraded into the prefix does not leave an inert `dsh_session` behind.

## Local development

For a loopback-only DSH development server without TLS, set
`secureCookie: false`; do not copy that setting to an internet-reachable
instance. Use a separate development password and environment directory:

```sh
mkdir -p "$PWD/.dsh-dev"
DSH_HOME="$PWD/.dsh-dev" dsh plugin --profile web add @seaveyon/dsh-web-login
DSH_HOME="$PWD/.dsh-dev" dsh plugin --profile web exec dsh-web-login-hash --env-path "$PWD/.dsh-dev/.env"
```

The CLI supports `--env-path PATH` and `--var NAME` for explicit development
paths and variable names. It rejects passwords shorter than eight characters
and values larger than the runtime's maximum accepted password size.

The path flag is `--env-path` and not `--env-file` because Node reserves the
latter: Node consumes `--env-file` wherever it appears on the command line,
including after the script path, loads the named file as a dotenv file, and
exits with status 9 if it is missing — which is every first run, since the file
is the one this command creates.

Run the package checks. Install first — the type checker, test runner, and
bundler are development dependencies:

```sh
bun install            # from the workspace root
bun run typecheck      # tsc over src and test
bun run test           # rslib build, then rstest
bun run test:coverage  # rstest with coverage and its thresholds
bun run build          # rslib, bundleless, with declarations
bun run pack:check     # build, then npm pack --dry-run
```

The suite includes property tests (`test/unit/parsing.property.test.ts`) over
the parsers that read attacker-chosen strings: the Cookie header, the forwarded
address header, the stored verifier, and the `.env` rewriter. They assert
invariants rather than outputs — that each is total, that values survive a round
trip, that widening a network never splits a bucket — because those are the
properties the calling code relies on.

Lint and formatting are configured once for the whole workspace, so run those
from the root: `bun run lint` and `bun run format:check`. `bun run check` at the
root does typecheck, lint, and format together across every package.

The CLI test spawns `dist/hash-password.js`, so it needs a build to have run.
`bun run test` and `bun run pack:check` both build first; only a direct
`bun run test:unit` expects `dist/` to exist already.

## Upgrade and removal

### Upgrade

1. Read the release notes.
2. Back up the existing profile and keep it and the environment file private.
3. When migrating from a pre-bundle release, remove the old manually inserted
   login row and readiness edits from the profile patch; retain only a
   config-by-id override like the example above. The bundle now owns those rows.
4. For a pre-bundle migration, run
   `dsh plugin --profile web add @seaveyon/dsh-web-login`; for a bundle-managed
   installation, run `dsh plugin --profile web update @seaveyon/dsh-web-login`.
   Then inspect `dsh --profile web --dump-config` and restart DSH.
5. Test anonymous navigation, API/WebSocket denial, sign-in, and logout before
   treating the upgrade as complete.

The verifier format is `scrypt$<salt hex>$<key hex>`; regenerate it only when
rotating the access password, not as a routine package-upgrade step.

### Remove

1. Run `dsh plugin --profile web remove @seaveyon/dsh-web-login`; this removes
   both the dependency and its bundle layer.
2. Restart DSH and verify the intended replacement access control is active
   before exposing the service.
3. Remove `LOGIN_PASSWORD_HASH` from the DSH environment file only after the
   gate is no longer configured to read it.

Removing the plugin without another access-control layer makes the DSH Web
surface reachable according to its listener and network configuration.

## Package contents and publication

The npm allowlist ships only the built output, the hash CLI, the installable
bundle patch, both READMEs, the security policy, and the MIT license. Tests,
local `.env` files, session state, and profile-specific configuration are
excluded.

Releases are automated from `main` and authenticated with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), so each version
carries provenance linking it to the workflow run that built it. Nothing is
published as part of installing, testing, or checking this repository locally.
