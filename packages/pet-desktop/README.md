# @seaveyon/dsh-pet-desktop

Zero-native (Zig + GPU canvas) desktop pet for the DSH Web surface. A 192×192
transparent, always-on-top, chromeless window whose whole surface is one Metal
GPU canvas — no WebView. It receives mood state from the `@seaveyon/dsh-pet`
Web plugin over a loopback HTTP bridge and plays the matching baked sprite
strip.

This is the formalized successor of the `/tmp/pet-spike` feasibility spike;
see `docs/` for the porting notes.

## Prerequisites

- macOS (the only platform the app builds for)
- Zig **0.16.0** — `mise install zig@0.16.0` (or any other install; the build
  pins `minimum_zig_version`)
- Network on first build: the zero-native SDK is a locked-commit tarball
  dependency (`build.zig.zon` → github.com/vercel-labs/zero-native @ 5665a35);
  zig fetches and caches it, so any clone reproduces this build.

## Commands

```sh
zig build          # or: bun run build   -> zig-out/bin/dsh-pet
zig build run      # or: bun run run     -> build (ReleaseFast) and launch
zig build test     # unit tests; never pass -Doptimize=Debug here (framework linking bug)
```

**Asset paths resolve against the process working directory** (the runtime's
image loader opens `assets/sprites/...` cwd-relative; only a packaged `.app`
bundle resolves them against `Contents/Resources` instead). So run the
`zig-out/bin/dsh-pet` binary from the package directory, exactly as
`zig build run` does.

## Sprites

`assets/sprites/` holds the baked strips — `sprites/<petId>/<mood>.png` for
petId ∈ {blob, cat, robot} × the 8 moods — plus `manifest.json`, the **single
source of truth** for strip geometry:

```json
{ "scale": 2, "frameSize": 128,
  "pets": { "<petId>": { "moods": { "<mood>":
    { "file": "<petId>/<mood>.png", "frames": 24, "frameDurationMs": 250 } } } } }
```

Each strip is `frames` horizontal frames of `frameSize`×`frameSize` CSS points
at `scale`× physical pixels (256×256 px at scale 2), RGBA with a transparent
background, looping seamlessly. The app parses the manifest at boot
(`src/manifest.zig`) — frame counts and cadences are never hardcoded — and
crops the current frame out of the strip with `image_src` in decoded physical
pixels (`frame i → x = i × 256, w = h = 256`), drawn into a 128pt widget.

Regenerate the strips after changing the plugin's pet artwork:

```sh
bun packages/pet-desktop/scripts/bake-sprites.mjs   # from the repo root
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
| working | `running` → `running-right` → `move_right` | |
| waiting | `waiting` | |
| sad | `failed` → `sad` | |
| sleeping | `sleeping`/`sleep`/`rest` if defined, else idle frames ×1.5 slower | Codex has no sleep state |
| celebrating | `jumping` → `bounce` | |
| pet | `waving` → `wave` | |

Limitations:

- **Four spare pet slots.** `src/manifest.zig` caps the manifest at 8 pets and
  the stock sets already ship 4, so up to 4 imported pets fit; the importer
  refuses rather than write a manifest the app would reject. Re-importing an
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

- The image registry has **16 slots**; one pet's 8 mood strips occupy 8.
  Switching petId unregisters the old pet's loaded strips synchronously
  (`fx.unregisterImage`) before loading the new set; strips whose load is
  still in flight are released by the `.image_done` handler on arrival
  (the stale branch — a load in flight can never be replaced implicitly).
  Strip image ids are stable: `100 + petIndex × 16 + moodIndex`.
- The default per-slot decode target is 1 MiB; a 24-frame strip decodes to
  6144×256 RGBA = 6 MiB, so `app.zon` raises `images.max_image_pixel_bytes`
  to the 8 MiB ceiling to keep the full 256px frame stride (no downscale).

## Plugin bridge

The app runs a loopback-only HTTP server (`src/server.zig`) on
`http://127.0.0.1:45731`:

- `POST /state` with `{"mood": "working", "petId": "blob", "name": "Mochi"}`
  → `200 {"ok":true}`; `mood` is one of `idle | thinking | working | waiting |
  sad | sleeping | celebrating | pet` (mirrors `@seaveyon/dsh-pet/desktop`'s
  `Mood` / `MOODS`). `petId` selects the sprite set — an unknown id falls
  back to `blob` (logged); `name` is accepted but not displayed in v1.
  Unknown mood → 400, invalid JSON → 400, body over 4 KiB → 413, any other
  path/method → 404.
- `GET /pets` → `200 application/json`: every pet the loaded manifest
  declares (built-ins and imports like Codex-imported bitmap pets), each
  with all 8 moods carrying `frames`, `frameDurationMs`, and `url`, e.g.
  `{"pets":[{"id":"blob","moods":{"idle":{"frames":24,"frameDurationMs":250,"url":"/sprites/blob/idle.png"},…}}]}`.
  → `503` when the manifest failed to load at boot.
- `GET /sprites/<pet>/<mood>.png` → `200 image/png`: the strip file itself.
  Only manifest-declared `file` names are served (exact match — no path
  traversal surface); unknown or undeclared paths → `404`.
- `OPTIONS` preflight → 204; every response carries
  `access-control-allow-origin: *` so the plugin can fetch/POST from the
  shell page's origin.

Enable the "桌面伴侣" (desktop companion) toggle in the pet plugin's settings
panel and the plugin starts POSTing mood updates.

The server thread feeds the UI loop through the framework's external-source
channel (`fx.openChannel` → thread-safe `ChannelHandle.post`, the
`examples/channel-monitor` pattern) — no UI-side polling, no app-owned locks.

## Interactions

- **Drag** anywhere to move the window (app-owned drag: `on_drag` starts the
  gesture, a 60 Hz poll follows `NSEvent.mouseLocation` until button-up).
- **Click** toggles a 1.25× zoom (stays inside the window's transparent
  safety margin).
- **Right-click** → Quit DSH Pet.

## Layout

```
app.zon          app manifest (id dev.seaveyon.dsh-pet, window/shell, image budget)
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
src/appkit.zig   dlsym'd Objective-C bridge (window placement, drag follow)
```
