# dsh-plugin-testkit

Test doubles and conformance suites for DSH Cordis plugins.

> This project is independent software and is not affiliated with or endorsed by
> DeepSeek AI.

A DSH plugin binds to host surfaces it cannot install: the `webServer` route
registry, the Cordis plugin context (services, effects, events), and — for hook
plugins — the tools execution waterfalls. Testing against either for real means
running a DSH process; testing against neither means testing nothing. This is the
third option — doubles with the same shape, small enough to read in one sitting,
plus the part that keeps them honest.

Nothing here is for production use. The tools pipeline is a **minimal** stand-in
for cookbook hook shapes (`tools/pre-execute` / `execute` / `post-execute`); it
is not `@deepseek-ai/dsh-tools` (no schema validation, guards, PTC, or cards).

## Install

```sh
npm install --save-dev @seaveyon/dsh-plugin-testkit
```

The contract suite declares tests, so it needs a runner. `@rstest/core` is an
optional peer: install it if you use `@seaveyon/dsh-plugin-testkit/contract`,
skip it if you only want the doubles.

## The doubles

```ts
import {
  createMockContext,
  createMockToolsPipeline,
  createMockWebServer,
} from '@seaveyon/dsh-plugin-testkit'

const web = createMockWebServer()
const ctx = createMockContext({ webServer: web.service })
const tools = createMockToolsPipeline(ctx)

apply(ctx, { /* your plugin's config */ })

const port = await web.listen()
// …drive real HTTP against 127.0.0.1:port…
const result = await tools.run({ name: 'echo', arguments: { q: 1 } })
ctx.dispose()
await web.close()
```

| Export | What it stands in for |
| --- | --- |
| `createMockWebServer()` | The DSH `webServer` registry, backed by a real `node:http` server. Exact routes beat the longest segment-boundary prefix, there is one fallback seat, and upgrades match an exact pathname. A handler rejection becomes an empty `400`, matching the host rather than leaking its message. |
| `createMockContext(services)` | The Cordis context. Collects teardowns in `ctx.teardowns`, records log lines in `ctx.logs`, exposes `listeners`, implements `provide` / `set` / `on` / `emit` / `waterfall`, and runs teardowns in reverse on `ctx.dispose()`. `provide`'s third argument (the availability predicate) is kept and readable through `ctx.available(name)`; as in Cordis it gates dependents, not `get`. |
| `createMockConnection(policy?)` | The host side of `connection`: `requestRejection(req)` answers with the status to reject with or `undefined`. `rejectWhen(policy)` swaps the fence at runtime; `consulted` records every question and answer. |
| `createMockToolsPipeline(ctx)` | A minimal tools pipeline on that context: `register` under `ctx.get('tools')`, and `run()` driving pre → body → post. Pre-deny skips the body; post still runs; ask defaults to deny via `answerAsk`. |
| `createMockServices(options?)` | For plugins composed through [`@seaveyon/dsh-di`](../di): a context and an `InstantiationService` built from one table of doubles, so `ctx.get('webServer')` and `services.get(IWebServer)` answer with the same mock. Takes the `webServer` / `connection` / `tools` doubles you already hold (or makes fresh ones), registers further host services by Cordis name, and accepts the plugin's own recipes through `entries`. `dispose()` tears down container, context, and socket. |
| `fakeRequest(options)` | An `IncomingMessage` over a fixed body, for the cases a socket makes awkward: a lying `Content-Length`, no `sec-fetch-*` headers, a request whose peer has gone. |
| `fakeStreamingRequest(options)` | A request whose body arrives under the test's control, for what is only observable mid-flight: whether a reader destroyed the request, whether it removed its listeners. |
| `fakeResponse()` | A `ServerResponse` that records `status`, lower-cased `headers`, and `body`. |
| `assertMutualAssignability(ab, ba)` | Type-level proof that two structural host types remain mutually substitutable. Compiles only while they agree; runtime is a no-op. |
| `runWaterfall(list, args, terminal?)` | The same waterfall scheduler the context uses, for tests that need a terminal other than `undefined`. |

### Client-side doubles

A dual-face plugin's browser bundle binds to services that only exist inside
the shell page. `createMockClientRuntime(options)` composes all of them and a
context whose `get` answers by the names the shell publishes:

| Member | What it stands in for |
| --- | --- |
| `loader` | `window.__ModuleLoader__`: captures the bundle's `load` call, `invokeFactory()` runs it against a static module table, and an undeclared external throws like the shell does. |
| `slots` | The `slots` service: records registrations per slot name instead of mounting. |
| `sessions` | `currentProvideInfo` (the two-level live-agent-state channel, driven with `publish` / `select`) and `list` (the store whose `getSnapshot().current` is the selected session, driven with `setCurrent`). |
| `settingsScope` | The persistence binder: namespaces over in-memory maps. |
| `workspaces` | `list` store plus `create` / `delete`, recording `created` and `deleted`. |
| `uiWorkspace` | `startSession(id)`, recording `started`. |
| `locale` | `register` / `bind` with `{param}` interpolation and active-locale fallback (`zh-CN` → `zh` → `en` → key), `setActive` to switch. |
| `context` | `get` over the table; `effect` runs the setup at once — as the host does — and `dispose()` runs the returned teardowns in reverse. |

Each double is also exported on its own (`createMockSessions`,
`createMockWorkspaces`, `createMockLocale`, …) for tests that need one seam.

The mocks implement the interfaces in `types.ts` rather than being cast to them,
so a plugin that starts using a member the real host provides and the mock does
not fails at compile time.

Event members on `PluginContext` are optional (plugins call them defensively).
The mock always implements them. Adding required event methods on the testkit
side alone would break bidirectional assignability checks against a narrower
plugin-local `PluginContext`.

## The conformance suite

A mock drifting from the host it imitates is the worst failure mode available to
a test suite: everything stays green while the thing being described stops
existing. The runners state behaviour once so the same assertions can be pointed
at any implementation.

```ts
import {
  runContextContract,
  runToolsPipelineContract,
  runWebServerContract,
} from '@seaveyon/dsh-plugin-testkit/contract'
import {
  createMockContext,
  createMockToolsPipeline,
  createMockWebServer,
} from '@seaveyon/dsh-plugin-testkit'

runWebServerContract('mock webServer', () => createMockWebServer())
runContextContract('mock context', () => createMockContext({}))
runToolsPipelineContract('mock tools', () => {
  const ctx = createMockContext({})
  return { ctx, pipeline: createMockToolsPipeline(ctx) }
})
```

| Runner | Load-bearing claims |
| --- | --- |
| `runWebServerContract` | Registry members are writable; replacements are visible to later callers; exact beats prefix; longest segment prefix; fallback last; handler rejection → empty 400; upgrades exact/unique/disposable. |
| `runContextContract` | `provide` visibility; the availability predicate gates `available()` but not `get`, and a throwing predicate reads as unavailable; `on` disposer; emit order; waterfall requires `next()`; short-circuit; reverse teardown. |
| `runToolsPipelineContract` | Pre-deny skips body; post runs after deny; execute wrapper around body; thrown body → `isError`; allow via `next()`; unanswered ask denies; register disposer / duplicates. |

## Portable contract cases

`/contract` remains the Rstest convenience entry. Consumers using another
runner can import runner-independent cases from `/contract/core` and supply a
fresh driver for every case. The helper always disposes the driver and returns
a report whose stable case ids are suitable for a CI compatibility artifact.

```ts
import {
  verifyContract,
  webServerContractCases,
} from '@seaveyon/dsh-plugin-testkit/contract/core'
import { createMockWebServerDriver } from '@seaveyon/dsh-plugin-testkit'

const report = await verifyContract(webServerContractCases, createMockWebServerDriver)
if (!report.passed) throw new Error(JSON.stringify(report))
```

The mock drivers are fast unit-test fixtures. The opt-in `/real` entry builds a
real Cordis context or `dsh-host-webserver` from packages installed beside the
test; the normal package entry never imports DSH. That makes the same route and
context cases usable in a pinned host-version matrix without making DSH a
runtime dependency of every testkit user.

## Current tool hooks

`createMockToolsPipeline()` is retained for the original cookbook-shaped,
legacy pipeline. New hook plugins should use `createMockToolHooks()`: it models
structured outcomes, symbol execution tokens, pre/execute/post phases,
`accept`/`block` post decisions, cancellation before dispatch, and the final
`tools/result` observation. It is still deliberately not a replacement for
`@deepseek-ai/dsh-tools`: schemas, guards, scopes, PTC, presentation, and
parallel scheduling belong to the real host.

## Sharing types with the package under test

A plugin should keep its own declaration of the host surfaces: that declaration
is its compatibility contract and belongs in the package that makes the promise.
Two hand-written copies is where drift lives, so assert their agreement rather
than trusting it:

```ts
import {
  assertMutualAssignability,
  type WebServerService as KitWebServer,
} from '@seaveyon/dsh-plugin-testkit'
import type { WebServerService } from '../src/types.js'

const identity = <T>(value: T): T => value
assertMutualAssignability<KitWebServer, WebServerService>(identity, identity)
```

Those lines compile only while the descriptions remain mutually substitutable.
An added required member, a narrowed parameter, or a changed return type on
either side is a compile error.

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
