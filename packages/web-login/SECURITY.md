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
- Password attempts are throttled per client key before scrypt runs. By default
  the key is the direct socket address. Set `trustProxy: true` only when the
  application is reachable exclusively through a trusted proxy that overwrites
  the configured forwarded-IP header on every request; otherwise clients can
  forge their own limiter identities.
- The login gate wraps HTTP routes registered after the
  `dshWebLoginReady` service is available. Every DSH Web route-owning loader row
  must inject that service; see
  [`examples/dsh-web/cordis.patch.yml`](examples/dsh-web/cordis.patch.yml).
  A route registered before decoration is outside the gate.

This repository is independent software and is not affiliated with or endorsed
by DeepSeek AI.
