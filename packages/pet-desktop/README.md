# @seaveyon/dsh-pet-desktop

Zero-native (Zig + GPU canvas) desktop pet for the DSH Web surface. A 192×192
transparent, always-on-top, chromeless window whose whole surface is one GPU
canvas (Metal on macOS; on Windows the SDK renders transparent windows through
its software reference renderer + GDI layered window) — no WebView. It receives
mood state from the `@seaveyon/dsh-pet` Web plugin over a loopback HTTP bridge
and plays the matching baked sprite strip.

This is the formalized successor of the `/tmp/pet-spike` feasibility spike;
see `docs/` for the porting notes.

## Prerequisites

- macOS or Windows (the two platforms the app builds for)
- Zig **0.16.0** — `mise install zig@0.16.0` (or any other install; the build
  pins `minimum_zig_version`)
- Network on first build: the zero-native SDK is a locked-commit tarball
  dependency (`build.zig.zon` → github.com/vercel-labs/zero-native @ 5665a35);
  zig fetches and caches it, so any clone reproduces this build.

## Commands

```sh
zig build          # or: bun run build   -> zig-out/bin/dsh-pet-desktop
zig build run      # or: bun run run     -> build (ReleaseFast) and launch
zig build test     # unit tests; never pass -Doptimize=Debug here (framework linking bug)
```

**Windows cross-build** (from macOS; no Windows SDK or MSVC needed — zig's
bundled mingw supplies the headers and import libraries):

```sh
zig build -Dtarget=x86_64-windows-gnu                              # -> zig-out/bin/dsh-pet-desktop.exe
zig build -Doptimize=ReleaseSmall -Dtarget=x86_64-windows-gnu --prefix zig-out-win-x64
```

On Windows the transparent window renders through the SDK's software
reference renderer (CPU + GDI layered-window present), which is fine for a
192×192 sprite; `gpu_backend = "metal"` in `app.zon`/`main.zig` is a portable
request value the Windows host maps to its default presenter.

**Asset paths resolve against the process working directory** (the runtime's
image loader opens `assets/sprites/...` cwd-relative; only a packaged `.app`
bundle resolves them against `Contents/Resources` instead). So run the
`zig-out/bin/dsh-pet-desktop` binary from the package directory, exactly as
`zig build run` does.

## Sprites

`assets/sprites/` holds the baked strips — `sprites/<petId>/<mood>.png` for
petId ∈ {deepseek-chan, ai-sleepy-silver-wolf, …imported} × the 8 moods — plus `manifest.json`, the **single
source of truth** for strip geometry:

```json
{ "scale": 2, "frameSize": 128,
  "pets": { "<petId>": { "moods": { "<mood>":
    { "file": "<petId>/<mood>.png", "frames": 24, "frameDurationMs": 250 } } } } }
```

An imported pet may additionally carry an optional `"drag"` entry with a
`"mirroredFile": "<petId>/drag-mirrored.png"` — a directional locomotion
strip and a copy with every frame mirrored horizontally in place (frame order
unchanged). `working` remains the agent's focused-work animation; dragging
uses `drag`, falling back to `working` only for older manifests. The mirror
exists because
the SDK's software reference renderer ignores the sign of negative-scale
transforms, and Windows transparent windows always render through that
path — so instead of mirroring at draw time with an Affine, a rightward
drag swaps in the pre-mirrored strip (image id slot 8, see
`src/manifest.zig`). Pets without the field fall back to the draw-time
Affine, which only Metal honors.

Each strip is `frames` horizontal frames of `frameSize`×`frameSize` CSS points
at `scale`× physical pixels (256×256 px at scale 2), RGBA with a transparent
background, looping seamlessly. The app parses the manifest at boot
(`src/manifest.zig`) — frame counts and cadences are never hardcoded — and
crops the current frame out of the strip with `image_src` in decoded physical
pixels (`frame i → x = i × 256, w = h = 256`), drawn into a 128pt widget.

Regenerate the strips after changing the plugin's pet artwork:

```sh
bun packages/pet-desktop/scripts/bake-sprites.mjs            # from the repo root
bun packages/pet-desktop/scripts/mirror-working-strips.mjs   # + the mirrored run strips
```

### Importing Codex pets

Codex-compatible pet packages (a directory with `pet.json` +
`spritesheet.webp`, the format used by Codex CLI `/pet` and community
galleries) can be converted into a native sprite set:

```sh
bun packages/pet-desktop/scripts/import-codex-pet.mjs <pet-dir|pet.json> [--name <id>] [--out <sprites-dir>]
```

The importer reads the Codex grid spec (`frame: { width, height, columns,
rows }`) and its animations, slices the sheet into frames, aspect-fits each
frame onto the manifest's square physical frame (256×256 px), and writes one
PNG strip per mood plus a `manifest.json` entry. Without an explicit `frame`,
the default grid follows `spriteVersionNumber`: v1 (field absent) is 8×9
(1536×1872, the codex-rs TUI layout) and v2 is 8×11 (1536×2288, the Codex
desktop app) — v2's two extra look-direction rows are ignored. WebP is
decoded with the macOS built-in `sips` (or `dwebp` elsewhere); a
`spritesheet.png` source needs no external tool.

Codex states map onto our 8 moods as follows (the first available Codex
animation wins; missing ones fall back to idle frames with a warning):

| Our mood | Codex animation(s) | Notes |
| --- | --- | --- |
| idle | `idle` | |
| thinking | `review` | |
| working | `running` → `running-right` → `move_right` | Agent task work; separate from drag locomotion |
| waiting | `waiting` | |
| sad | `failed` → `sad` | |
| sleeping | `sleeping`/`sleep`/`rest` if defined, else idle frames ×1.5 slower | Codex has no sleep state |
| celebrating | `jumping` → `bounce` | |
| pet | `waving` → `wave` | |

The importer separately maps the optional native-left `drag` strip from
`running-left` → `move_left` → `running-right` → `move_right`, then produces
its right-facing mirrored counterpart. This lets carrying use a real gait
without changing the agent's ordinary `working` animation.

Limitations:

- **Six spare pet slots.** `src/manifest.zig` caps the manifest at 8 pets and
  the stock sets already ship 2 (`deepseek-chan`, `ai-sleepy-silver-wolf`),
  so up to 6 imported pets fit; the importer refuses rather than write a
  manifest the app would reject. Re-importing an
  existing id replaces it and is always allowed.
- **Timing is per-strip.** Codex's per-frame idle durations, `loop`/fallback
  chains, and the 3×-repeat-then-idle default cadence don't fit the
  manifest schema; strips keep the primary frames at one average/uniform
  `frameDurationMs` (custom animations: 1000/fps) and loop seamlessly.
- **Strips cap at 24 frames** (the baker's ceiling; the 8 MiB decode budget
  in `app.zon` fits 32 at most). Longer Codex animations are thinned evenly
  with the duration stretched to preserve the total loop time, with a
  warning.

Two framework limits shaped the wiring:

- The image registry has **16 slots**; one pet's strips occupy 9 (the 8
  mood strips + the mirrored run strip). Switching petId unregisters the
  old pet's loaded strips synchronously
  (`fx.unregisterImage`) before loading the new set; strips whose load is
  still in flight are released by the `.image_done` handler on arrival
  (the stale branch — a load in flight can never be replaced implicitly).
  Strip image ids are stable: `100 + petIndex × 16 + moodIndex`, with
  slot 8 reserved for the mirrored run strip.
- The default per-slot decode target is 1 MiB; a 24-frame strip decodes to
  6144×256 RGBA = 6 MiB, so `app.zon` raises `images.max_image_pixel_bytes`
  to the 8 MiB ceiling to keep the full 256px frame stride (no downscale).

## Plugin bridge

The app runs a loopback-only HTTP server (`src/server.zig`) on
`http://127.0.0.1:45731`:

- `POST /state` with `{"mood": "working", "petId": "deepseek-chan", "name": "Mochi", "locale": "en"}`
  → `200 {"ok":true}`; `mood` is one of `idle | thinking | working | waiting |
  sad | sleeping | celebrating | pet` (mirrors `@seaveyon/dsh-pet/desktop`'s
  `Mood` / `MOODS`). `petId` selects the sprite set — an unknown id falls
  back to the manifest's first pet (logged); `name` is accepted but not
  displayed in v1; `locale` (`zh` | `en`) localizes the app's context menu.
  Unknown mood → 400, invalid JSON → 400, body over 4 KiB → 413, any other
  path/method → 404.
- `GET /pets` → `200 application/json`: every pet the loaded manifest
  declares (built-ins and imports like Codex-imported bitmap pets), each
  with all 8 moods carrying `frames`, `frameDurationMs`, and `url`, plus an
  `eventsUrl` for the liveness stream below, e.g.
  `{"pets":[{"id":"deepseek-chan","moods":{"idle":{"frames":6,"frameDurationMs":1100,"url":"/sprites/deepseek-chan/idle.png"},…}}],"eventsUrl":"/events"}`.
  → `503` when the manifest failed to load at boot.
- `GET /events` → `200 text/event-stream`: an SSE **liveness** stream. No
  events are ever published — the open connection itself is the signal, so
  the plugin notices the moment the app quits instead of waiting for the
  next poll. Runs on its own thread per connection so it can't starve
  `/state`.
- `GET /sprites/<pet>/<mood>.png` → `200 image/png`: the strip file itself.
  Only manifest-declared `file` names are served (exact match — no path
  traversal surface); unknown or undeclared paths → `404`.
- `OPTIONS` preflight → 204. Responses carry a CORS grant only for an
  **allowed origin**, echoed back with `vary: origin` — never `*`, which
  would have let every page open in the browser repaint the pet, read its
  name, list the imported pets, and watch `/events`. `src/origin.zig`
  decides: loopback origins (`http(s)://localhost`, `127.0.0.1`, `[::1]`,
  any port) are always allowed; `DSH_PET_DESKTOP_ORIGINS` — a
  comma-separated list of exact origins — adds a shell reached through a
  reverse proxy or LAN name on the same machine. A request carrying any
  other `Origin` is answered `403` before its route is looked at (its
  preflight gets a bare `204`); a request with no `Origin` header is not a
  browser and is served without a grant.
- The port is fixed at 45731 and written once per side — here and
  `DESKTOP_BRIDGE_PORT` in the plugin, which has a test reading
  `server.zig` to keep them equal. If the app cannot listen on it (usually a
  second copy already running), it says so on stderr / the run log and
  quits instead of leaving a pet on screen that nothing can reach.

The bridge is on by default — there is no companion toggle in the pet
plugin's settings panel; as soon as the plugin is installed it starts POSTing
mood updates, and when this app isn't running the sends fail silently. On a
loopback page the panel can also start this app for you: the pet plugin's
host face serves `POST /dsh-pet/launch-desktop`, which first spawns the
binary from the install's per-platform optional package
(`@seaveyon/dsh-pet-desktop-<platform>-<arch>`), then asks Launch Services to
open the bundle id `dev.seaveyon.dsh-pet-desktop` (falling back to
`/Applications/DSH Pet.app` and `~/Applications/DSH Pet.app`;
`DSH_PET_DESKTOP_APP` overrides the search). Whichever path starts the app,
the launcher hands it the requesting page's origin as
`DSH_PET_DESKTOP_ORIGINS` (through the environment, or `open --env`) when
that origin is not loopback, so a proxied shell needs no hand configuration;
a copy you start yourself gets the variable from you.

The server thread feeds the UI loop through the framework's external-source
channel (`fx.openChannel` → thread-safe `ChannelHandle.post`, the
`examples/channel-monitor` pattern) — no UI-side polling, no app-owned locks.

## Interactions

- **Drag** anywhere to move the window (app-owned drag: `on_drag` starts the
  gesture, a 60 Hz poll follows the absolute pointer position —
  `NSEvent.mouseLocation` on macOS, `GetCursorPos` on Windows — until
  button-up). The
  pet plays its directional drag strip while carried — a display-layer override
  (`Model.effectiveMood`), so bridge state keeps landing underneath and the
  pet returns to the latest mood on release.
- **Click** toggles a 1.25× zoom (stays inside the window's transparent
  safety margin).
- **Right-click** → Quit DSH Pet.

## Layout

```
app.zon          app manifest (id dev.seaveyon.dsh-pet-desktop, window/shell, image budget)
build.zig        native_sdk.addApp graph
build.zig.zon    SDK tarball dependency (locked sha + hash)
assets/sprites/  baked strips + manifest.json (single source for frame geometry)
assets/          icon.icns
src/main.zig     app entry, window/canvas config, transparent tokens
src/model.zig    TEA model/update: strip slot management, frame timer, state bridge, drag
src/view.zig     atlas-cropped sprite in the root container (press/drag/context menu)
src/manifest.zig manifest.json parser, image-id mapping, animation arithmetic
src/state.zig    Mood enum, /state JSON and channel-line codecs
src/server.zig   loopback HTTP bridge thread (/state POST, /pets + /sprites GETs)
src/windowing.zig platform-neutral windowing API (window placement, drag follow), dispatching per OS
src/appkit.zig   macOS backend: dlsym'd Objective-C bridge
src/win32.zig    Windows backend: raw user32 externs (window find/move, cursor, button state)
```
