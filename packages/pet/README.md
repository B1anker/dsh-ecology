# @seaveyon/dsh-pet

A desktop pet for the [DSH](https://github.com/deepseek-ai) Web surface.
[中文文档](README.zh-CN.md)

A hand-crafted sprite lives at the corner of your DSH Web GUI and mirrors what
your agent is doing right now: thinking, running tools, waiting for your
approval, celebrating a finished turn, dozing off when you both go quiet.

![Mochi the blob mirroring agent state: idle, thinking, working, celebrating, petted](assets/demo.gif)

## Install

```sh
dsh plugin --profile web add @seaveyon/dsh-pet
```

The package declares `dsh.bundle.patch`, so `dsh plugin` both installs the npm
dependency and appends its [`cordis.patch.yml`](cordis.patch.yml) row to the
profile — no manual YAML editing. Restart `dsh web` and hard-refresh the page;
the pet appears in the bottom-right corner.

> The row exists because the client module system discovers plugin bundles by
> scanning the host Loader's active entries: a package installed as a plain
> dependency is never served. The host plugin the row activates is a deliberate
> no-op — every feature lives in the browser bundle.

## Using the pet

- **Drag** it anywhere; the position is remembered per browser.
- **Click** (or focus it and press Enter/Space) to pet it.
- **Double-click** to hide it; click the paw button to call it back.
- While the agent works, a bubble shows the tool currently running; when the
  agent waits for you, the pet waits with it; when a turn completes, it
  celebrates.

Configure it under **Settings → Pet**: four built-in sprites (blob, cat,
robot, DeepSeek-chan「DeepSeek 酱」), a name, size from 0.5× to 2×, and
visibility.

Settings persist through the DSH settings service when it is available and
fall back to `localStorage` — including for browsers on a remote host, whose
settings RPCs never leave the server.

### Imported desktop pets

If the [pet desktop companion](../pet-desktop) is running, any bitmap pets
imported into it (for example a Codex pet pack such as
`ai-sleepy-silver-wolf`) also appear in **Settings → Pet**, marked with a
*Desktop* badge. The plugin discovers them over the companion's loopback
server (`GET http://127.0.0.1:45731/pets`) and animates their sprite strips in
the overlay with stepped CSS background animation — one strip per mood, sized
exactly like the built-in sprites. Discovery is best-effort: if the desktop
app is offline, the picker simply shows the built-in roster, and an imported
pet that is selected but unreachable falls back to the blob instead of leaving
an empty corner.

## How it works

The package is a dual-face DSH plugin whose host face is a no-op Cordis plugin
(see [`src/index.ts`](src/index.ts)) and whose client face
([`src/client/`](src/client)) is served by the shell's client module system at
`/plugins/@seaveyon/dsh-pet/client.js`. The client reads live agent state from
the `sessions.currentProvideInfo` provide channel and derives the pet's mood
from the conversation snapshot — no LLM calls, no network, no telemetry.

The hand-written host contract types and the facts they rest on are documented
at the top of [`src/client/host-types.ts`](src/client/host-types.ts).

## Development

```sh
bun install
bun run build   # emits dist/index.js (host no-op) and dist/client.js (browser bundle)
bun run test    # jsdom suite against the client doubles in @seaveyon/dsh-plugin-testkit
```

## License

MIT. This project is independent software and is not affiliated with or
endorsed by DeepSeek AI.
