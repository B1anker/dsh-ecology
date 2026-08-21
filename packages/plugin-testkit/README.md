# dsh-plugin-testkit

Test doubles and a registry conformance suite for DSH Cordis plugins.

> This project is independent software and is not affiliated with or endorsed by
> DeepSeek AI.

A DSH plugin binds to two host surfaces it cannot install: the `webServer` route
registry and the Cordis plugin context. Testing against either for real means
running a DSH process; testing against neither means testing nothing. This is the
third option — doubles with the same shape, small enough to read in one sitting,
plus the part that keeps them honest.

Nothing here is for production use.

## Install

```sh
npm install --save-dev @seaveyon/dsh-plugin-testkit
```

The contract suite declares tests, so it needs a runner. `@rstest/core` is an
optional peer: install it if you use `@seaveyon/dsh-plugin-testkit/contract`,
skip it if you only want the doubles.

## The doubles

```ts
import { createMockContext, createMockWebServer } from '@seaveyon/dsh-plugin-testkit'

const web = createMockWebServer()
const ctx = createMockContext({ webServer: web.service })

apply(ctx, { /* your plugin's config */ })

const port = await web.listen()
// …drive real HTTP against 127.0.0.1:port…
ctx.dispose()
await web.close()
```

| Export | What it stands in for |
| --- | --- |
| `createMockWebServer()` | The DSH `webServer` registry, backed by a real `node:http` server. Exact routes beat prefixes, one fallback seat, upgrades matched by prefix. A handler that throws becomes a `500`, so a plugin bug fails an assertion instead of timing out and being blamed on the suite. Every disposer is idempotent and identity-checked, because Cordis may unwind a context twice and the plugin may have re-registered in between. |
| `createMockContext(services)` | The Cordis context. Collects teardowns in `ctx.teardowns`, records log lines in `ctx.logs` rather than printing them, and runs teardowns in reverse on `ctx.dispose()`. |
| `fakeRequest(options)` | An `IncomingMessage` over a fixed body, for the cases a socket makes awkward: a lying `Content-Length`, no `sec-fetch-*` headers, a request whose peer has gone. |
| `fakeStreamingRequest(options)` | A request whose body arrives under the test's control, for what is only observable mid-flight: whether a reader destroyed the request, whether it removed its listeners. |
| `fakeResponse()` | A `ServerResponse` that records `status`, lower-cased `headers`, and `body`. |

The mocks implement the interfaces in `types.ts` rather than being cast to them,
so a plugin that starts using a member the real host provides and the mock does
not fails at compile time.

## The conformance suite

A mock drifting from the host it imitates is the worst failure mode available to
a test suite: everything stays green while the thing being described stops
existing. `runWebServerContract` states the registry's behaviour once so the same
assertions can be pointed at any implementation.

```ts
import { runWebServerContract } from '@seaveyon/dsh-plugin-testkit/contract'
import { createMockWebServer } from '@seaveyon/dsh-plugin-testkit'

runWebServerContract('mock webServer', () => createMockWebServer())
```

It asserts that the three registry members are writable properties and that a
later caller reaches a replacement; that `register`, `registerFallback`, and
`registerUpgrade` each return a working disposer; that an exact route beats a
matching prefix; that the fallback fires only when nothing else matched; and that
an async handler is awaited.

The first of those is the load-bearing one for any plugin that guards routes.
Such a plugin works by replacing the registry members with wrappers, so "these
are writable, and a later caller sees the replacement" is not an implementation
detail of a mock — it is the mechanism the whole approach rests on.

## Sharing types with the package under test

A plugin should keep its own declaration of the host surfaces: that declaration
is its compatibility contract and belongs in the package that makes the promise.
Two hand-written copies is where drift lives, so assert their agreement rather
than trusting it:

```ts
import type { WebServerService as KitWebServer } from '@seaveyon/dsh-plugin-testkit'
import type { WebServerService } from '../src/types.js'

const identity = <T>(value: T): T => value
const kitFitsPlugin: (value: KitWebServer) => WebServerService = identity
const pluginFitsKit: (value: WebServerService) => KitWebServer = identity
```

Those two lines compile only while the descriptions remain mutually
substitutable. An added required member, a narrowed parameter, or a changed
return type on either side is a compile error.

## Development

From the workspace root:

```sh
bun install
bun run check          # typecheck, lint, format, host contract
bun run test           # build, then every package's suite
bun run test:coverage  # the same, with coverage thresholds enforced
```

This package's coverage thresholds are higher than the plugin's, for a reason
particular to a testkit: an uncovered branch in a test double is a behaviour no
downstream suite has ever observed, and every one of them will trust it as if
they had.

## License

MIT. See [LICENSE](LICENSE).
