# @seaveyon/dsh-pet

A desktop pet for the [DSH](https://github.com/deepseek-ai) Web surface.
[中文文档](README.zh-CN.md)

This plugin is the desktop pet's **mood source and settings panel** — it
renders no pet on the web page itself. It watches what your agent is doing
right now (thinking, running tools, waiting for your approval, celebrating a
finished turn, dozing off when you both go quiet), derives a mood, and pushes
every change to the [desktop companion app](../pet-desktop), where the pet
actually lives on your screen.

![DeepSeek-chan, the default built-in pet, mirroring agent state: idle, thinking, working, celebrating, petted](assets/demo.gif)

> The demo is rendered from the sprite strips that actually ship in the
> desktop app (`render-demo-gif.mjs` in
> [`../pet-desktop/scripts`](../pet-desktop/scripts)) — what you see is what
> sits on your desktop.

## Install

```sh
dsh plugin --profile web add @seaveyon/dsh-pet
```

The package declares `dsh.bundle.patch`, so `dsh plugin` both installs the npm
dependency and appends its [`cordis.patch.yml`](cordis.patch.yml) row to the
profile — no manual YAML editing. Restart `dsh web` and hard-refresh the page;
the plugin starts feeding the desktop app immediately.

> The row exists because the client module system discovers plugin bundles by
> scanning the host Loader's active entries: a package installed as a plain
> dependency is never served. The host plugin the row activates owns exactly
> one route — the desktop-app launcher below — and nothing else.

## Using the pet

The pet itself appears on your desktop, courtesy of the companion app. What
you get in the web UI is **Settings → Pet**:

- Which pet shows on the desktop: the two built-in sprites (deepseek-chan
  and ai-sleepy-silver-wolf), plus any pets imported into the desktop app.
- The pet's name.
- The desktop companion's summon button. The bridge itself is always on —
  driving the desktop pet is this plugin's whole job, and when the desktop
  app isn't running the bridge fails silently, so it costs nothing.

### Launching the desktop app from the panel

On a loopback page (the DSH server on the same machine as the browser), the
companion row offers a **Launch desktop app** button whenever the desktop app
is unreachable. The button asks the plugin's host face, which runs inside the
DSH server, to start the app via `POST /dsh-pet/launch-desktop`
([`src/launch.ts`](src/launch.ts)): loopback peers only, a mandatory custom
header so no cross-origin page can drive-by trigger it, and the login gate's
session when the profile has one. On a remote host the
button never appears — launching would start the pet on the server, not on
your desktop.

What the host starts, in order:

1. The companion binary from this install's per-platform optional package —
   `@seaveyon/dsh-pet-desktop-darwin-arm64`, `-darwin-x64`, or `-win32-x64`,
   of which npm's os/cpu selectors download only the one matching your
   machine. It is version-locked to the plugin (the optionalDependencies
   entries name the exact same version), so the bridge protocol can never
   drift, and on macOS npm-installed files carry no quarantine attribute,
   so it spawns without a Gatekeeper prompt. Its sprite assets stay in this
   package (`desktop/assets/`, staged by the release workflow); the launcher
   points the binary at them through `DSH_PET_DESKTOP_ASSETS`. In a
   development checkout the staged `desktop/dsh-pet-desktop-*` copy
   (`bun run build:desktop`) plays this role.
2. An installed copy, per platform. On macOS, `DSH Pet.app` — resolved by
   bundle id first, then the standard Applications folders (development and
   pre-split installs). On Windows there is no `open -b` and no installer,
   so the fallback is the `DSH_PET_DESKTOP_APP` environment variable pointing
   at an exe.

If the host finds neither, the panel links to the download page instead.

Settings persist through the DSH settings service when it is available and
fall back to `localStorage` — including for browsers on a remote host, whose
settings RPCs never leave the server.

### The picker is the desktop roster

The picker's single source of truth is the desktop app: when it answers
`GET http://127.0.0.1:45731/pets`, that roster — built-ins included — is the
whole list, and every preview is a sprite strip off the bridge server played
with stepped CSS background animation. Known built-in ids keep their
localized names; anything else is an
import, humanized from its id and marked with an *Imported* badge. Until the
desktop app answers (or if it is unreachable) the picker stays empty — the
pet lives on the desktop, so the page offers no stand-in roster — with a
"not connected" hint, and discovery retries quietly a couple of times while
the panel stays open. A stored petId stays selected once the desktop
answers, since ids match on both sides. The desktop app itself owns what
happens to a selected-but-unavailable imported pet on its own surface.

## How it works

The package is a dual-face DSH plugin whose host face
([`src/index.ts`](src/index.ts)) registers a single launcher route and whose
client face
([`src/client/`](src/client)) is served by the shell's client module system at
`/plugins/@seaveyon/dsh-pet/client.js`. The client reads live agent state from
the `sessions.currentProvideInfo` provide channel, derives the pet's mood from
the conversation snapshot ([`src/client/mood.ts`](src/client/mood.ts)), and
POSTs every change to the companion app's loopback server
([`src/client/bridge.ts`](src/client/bridge.ts)) — no LLM calls, no telemetry,
and the only network traffic is loopback.

The hand-written host contract types and the facts they rest on are documented
at the top of [`src/client/host-types.ts`](src/client/host-types.ts).

## Development

```sh
bun install
bun run build   # emits dist/index.js (host: the launch route) and dist/client.js (browser bundle)
bun run test    # jsdom suite against the client doubles in @seaveyon/dsh-plugin-testkit
```

## License

MIT. This project is independent software and is not affiliated with or
endorsed by DeepSeek AI.
