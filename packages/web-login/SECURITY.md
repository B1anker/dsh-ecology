# Security policy

## Supported versions

Security fixes are made on the latest release of `@seaveyon/dsh-web-login`.
Before a first npm release exists, report issues against the default branch of
this repository.

The package is designed for the DSH Web host package
`@deepseek-ai/dsh-host-webserver` `0.1.0-rc.7` and Cordis 4 (`^4.0.1`), running
on Node.js 20.11 or later. Compatibility with other DSH Web releases is not
promised until it has been tested and documented.

## Reporting a vulnerability

Please do **not** open a public issue for a credential bypass, session flaw, or
other issue that could expose a deployed DSH Web surface. Use GitHub's private
security-advisory reporting flow for this repository, or contact the repository
owner privately through GitHub. Include:

- affected package version and Node.js version;
- DSH Web host and Cordis versions;
- a minimal reproduction or proof of concept; and
- whether the deployment is behind a TLS-terminating proxy.

Do not include passwords, scrypt verifier values, cookies, full request logs,
or production URLs in a report. Acknowledgement and a remediation plan will be
provided after the report is reproduced.

## Deployment assumptions and boundaries

This is an application-layer access gate, not a replacement for network access
control or TLS.

- **HTTPS is required in production.** `secureCookie` defaults to `true`; leave
  it enabled when a reverse proxy terminates TLS. The proxy-to-dsh hop must be
  private or otherwise protected. Disabling it is only appropriate for local
  HTTP development.
- The hash generator stores a *verifier*, not a plaintext password, in the DSH
  environment file. Treat that file as credential material: it is written at
  mode `0600`, must not be committed, copied to support tickets, or logged.
- Sessions are random opaque IDs stored only in process memory. Restarting DSH
  invalidates every session. This deliberately avoids persistent signing keys
  and a session database, but it is not a multi-instance/shared-session design.
- Password attempts are throttled before scrypt runs, per network and again
  across all of them. By default the identity is the direct socket address,
  masked to a `/32` for IPv4 and a `/64` for IPv6 — an attacker who holds an
  allocation is one client, not one client per address. Set `trustProxy: true`
  only when the application is reachable exclusively through a trusted proxy that
  overwrites the configured forwarded-IP header on every request; otherwise
  clients can forge their own limiter identities.
- Both bounded tables fail closed. When the limiter is tracking
  `maxAttemptClients`, a client with no existing record is refused rather than
  admitted untracked, and when the session table is full a new sign-in receives a
  `503` rather than evicting someone. The open alternative is a state an attacker
  can reach on purpose.
- scrypt runs on the threadpool under a concurrency gate, not on the event loop.
  Past `kdfConcurrency` running and `kdfQueueDepth` waiting, a sign-in is refused
  with a `503` and a `Retry-After`. This is a deliberate availability trade: an
  unauthenticated caller can cost the process a bounded amount of CPU and memory,
  and refusing at the bound is what stops that from becoming the whole process.
- The session cookie is named `__Host-dsh_session` wherever `secureCookie` is on.
  That prefix is what makes host scoping browser-enforced, which matters because
  cookies are scoped by host and path rather than by origin: without it, any
  sibling subdomain — or any network position that can answer for one over plain
  HTTP — can set `dsh_session` for the parent domain and have the browser send it
  here. A session cookie that arrives twice with conflicting values is treated as
  absent, because the header carries no evidence of which one came from where.
- The login gate wraps HTTP routes registered after the
  `dshWebLoginReady` service is available. Every DSH Web route-owning loader row
  must inject that service; the package's installable bundle layer is
  [`cordis.patch.yml`](cordis.patch.yml).
  A route registered before decoration is outside the gate.

This repository is independent software and is not affiliated with or endorsed
by DeepSeek AI.
