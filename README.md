# dsh-web-login

A cookie-session login gate for the DSH Web surface. It replaces a reverse
proxy's browser-native HTTP Basic prompt with a small self-contained sign-in
page while protecting the Web UI, API routes, plugin assets, the SPA fallback,
and WebSocket upgrades.

> **Status:** public-source preparation, version `0.1.0`. The package is tested
> against the route-registry contract of
> `@deepseek-ai/dsh-host-webserver` `0.1.0-rc.7` and Cordis `^4.0.1`. It requires
> Node.js **20.11.0 or later**. This project is independent software and is not
> affiliated with or endorsed by DeepSeek AI.

## What it does

- reads an scrypt password verifier from an environment variable, never from
  plugin configuration;
- creates opaque, random in-memory sessions behind a host-only `HttpOnly`,
  `SameSite=Strict` cookie;
- redirects browser document navigations to `/login`, while API, plugin, and
  other resource routes get a machine-readable `401` instead of an HTML login
  page;
- requires `POST /logout` and invalidates both the server session and browser
  cookie;
- protects routes registered through the DSH `webServer` registry, including
  exact routes, prefix routes, SPA fallback, and WebSocket upgrades;
- limits failed password attempts **before** scrypt runs, with bounded memory
  for both limiter state and sessions; and
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
4. Apply the readiness injection for every Web route owner. Without it, a DSH
   loader row can register routes before the gate decorates the registry.

For the full security model and reporting path, see
[`SECURITY.md`](SECURITY.md).

## Install

Install the package where the DSH Web plugin loader resolves packages:

```sh
npm install @seaveyon/dsh-web-login
```

The package declares the DSH host and Cordis packages as optional peers because
a normal DSH Web installation already provides them. Use it with the tested
versions:

```text
@deepseek-ai/dsh-host-webserver  0.1.0-rc.7
@deepseek-ai/cordis              ^4.0.1
```

Generate a verifier from an interactive terminal (the password is not echoed):

```sh
npx dsh-web-login-hash
```

The command writes `LOGIN_PASSWORD_HASH=scrypt$…` into `${DSH_HOME}/.env` when
`DSH_HOME` is set, otherwise `~/.dsh/.env`. It preserves unrelated assignments,
uses an atomic replacement, and sets the result to mode `0600`. It deliberately
prints neither the password nor the verifier. The DSH home directory must exist
before running the command.

If DSH is launched by a service manager, make sure that process actually loads
that environment file. The plugin fails closed at startup if the configured
verifier is absent or malformed.

### Add the Web-profile overlay

Add the login plugin and the readiness dependency to the **existing DSH Web
Cordis manifest**. The supported `0.1.0-rc.7` composition has the route-owning
rows `web-runtime`, `connection`, `modules`, and `client-hmr`; retain all of
their existing dependencies and add `dshWebLoginReady` to each.

Start from the annotated fragment in
[`examples/dsh-web/cordis.patch.yml`](examples/dsh-web/cordis.patch.yml):

```yaml
plugins:
  dsh-web-login:
    package: '@seaveyon/dsh-web-login'
    config:
      secureCookie: true
      title: DSH Web

  web-runtime:
    inject: [dshWebLoginReady] # append; do not replace existing injections
  connection:
    inject: [dshWebLoginReady]
  modules:
    inject: [dshWebLoginReady]
  client-hmr:
    inject: [dshWebLoginReady]
```

The exact outer syntax belongs to the installed DSH profile loader; merge this
fragment into its current plugin entries rather than replacing the entire
manifest. The important contract is:

1. `dsh-web-login` starts after the `webServer` service exists;
2. each route-owning entry injects `dshWebLoginReady`; and
3. each of those entries registers its routes only after that dependency is
   available.

Restart DSH after changing its plugin manifest or environment. A document
navigation to `/` should redirect to `/login`; sign in, then confirm the Web
UI, API, plugin assets, and WebSocket-backed features work. In a private or
incognito window, confirm that direct API and WebSocket requests are denied.

## Configuration

All configuration is validated. Unknown or misspelled keys stop startup instead
of silently selecting an unsafe default.

| Key | Default | Meaning |
| --- | --- | --- |
| `passwordHashEnv` | `LOGIN_PASSWORD_HASH` | Name of the environment variable holding `scrypt$<salt hex>$<key hex>`. |
| `title` | `DSH Web` | Login-page and browser-title text (1–120 characters). |
| `secureCookie` | `true` | Adds the `Secure` cookie attribute. Keep it enabled outside localhost HTTP development. |
| `sessionTtlMs` | 30 days | Session lifetime; restart always signs users out sooner. Range: 1 minute–365 days. |
| `maxSessions` | `10000` | Maximum live sessions. At capacity, a new login receives `503`; live sessions are never evicted. |
| `maxBodyBytes` | `4096` | Maximum accepted login form body. Range: 64 bytes–1 MiB. |
| `attemptLimit` | `5` | Failed attempts in a window before blocking that client. |
| `attemptWindowMs` | 15 minutes | Failure-counting window. |
| `blockMs` | 15 minutes | Duration of a password-attempt block. |
| `maxAttemptClients` | `10000` | Maximum limiter records, preventing unbounded memory use. |
| `sweepIntervalMs` | 5 minutes | Interval for removing expired session and limiter records. |
| `trustProxy` | `false` | Use a forwarded client-IP header for throttling only behind a trusted proxy. |
| `clientIpHeader` | `x-forwarded-for` | Lower-cased header name used only when `trustProxy` is true. |

### Trusted proxies and the limiter

With the default `trustProxy: false`, throttling uses the direct socket address,
which clients cannot forge. Enable `trustProxy` **only** if DSH is unreachable
except through a trusted proxy that overwrites the forwarded-IP header on every
request. The plugin uses the final comma-separated hop, because that is the one
the proxy appended after seeing its peer.

```yaml
plugins:
  dsh-web-login:
    config:
      trustProxy: true
      clientIpHeader: x-forwarded-for
```

A proxy that merely passes through an incoming `X-Forwarded-For` header lets
clients create arbitrary limiter identities and defeats per-client throttling.

## Local development

For a loopback-only DSH development server without TLS, set
`secureCookie: false`; do not copy that setting to an internet-reachable
instance. Use a separate development password and environment directory:

```sh
mkdir -p "$PWD/.dsh-dev"
DSH_HOME="$PWD/.dsh-dev" npx dsh-web-login-hash --env-file "$PWD/.dsh-dev/.env"
```

The CLI supports `--env-file PATH` and `--var NAME` for explicit development
paths and variable names. It rejects passwords shorter than eight characters
and values larger than the runtime's maximum accepted password size.

Run the package checks with no dependency installation required:

```sh
npm run lint
npm test
npm run pack:check
```

## Upgrade and removal

### Upgrade

1. Read the release notes and verify the target DSH host/Cordis compatibility.
2. Back up the Web-profile manifest and keep the existing environment file
   private.
3. Upgrade the package, run the checks above, and restart DSH.
4. Test anonymous navigation, API/WebSocket denial, sign-in, and logout before
   treating the upgrade as complete.

The verifier format is `scrypt$<salt hex>$<key hex>`; regenerate it only when
rotating the access password, not as a routine package-upgrade step.

### Remove

1. Remove `dsh-web-login` from the Web manifest.
2. Remove `dshWebLoginReady` from the route-owner injection arrays that were
   added during installation.
3. Restart DSH and verify the intended replacement access control is active
   before exposing the service.
4. Remove `LOGIN_PASSWORD_HASH` from the DSH environment file only after the
   gate is no longer configured to read it.

Removing the plugin without another access-control layer makes the DSH Web
surface reachable according to its listener and network configuration.

## Package contents and publication

The npm allowlist ships only source, the hash CLI, example manifest fragment,
README, security policy, and MIT license. Tests, local `.env` files, session
state, and deployment configuration are excluded. This repository prepares
package metadata for a later public release; it does not publish a package as
part of installation, testing, CI, or its release-preparation workflow.
