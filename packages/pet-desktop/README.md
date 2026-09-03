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
- `OPTIONS` preflight → 204; every response carries
  `access-control-allow-origin: *` so the plugin can POST from the shell page.

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
src/server.zig   loopback HTTP state server thread
src/appkit.zig   dlsym'd Objective-C bridge (window placement, drag follow)
```
