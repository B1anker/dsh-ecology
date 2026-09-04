//! dsh-pet-desktop model: the runtime-parsed sprite manifest (src/manifest.zig,
//! the single source for strip geometry), a manifest-paced repeating
//! frame timer, the plugin state bridge (HTTP server thread ->
//! external-source channel -> state_event Msgs), and the press/quit
//! intents.
//!
//! Sprite playback: one registry slot per (pet, mood) strip — 8 moods,
//! one active pet, so 8 of the 16 image-registry slots are in use.
//! Strips register under stable ids (`manifest.imageId`); switching
//! petId unregisters the old pet's LOADED strips synchronously
//! (`fx.unregisterImage` is registry surgery, no terminal) and leaves
//! in-flight loads to their own terminal, whose handler unregisters
//! them on arrival (the stale branch) — a load in flight is never
//! implicitly replaced, and pet-scoped ids never collide across sets.
//! The view crops the current frame out of the strip with
//! `image_src` in decoded physical pixels (atlas path, nearest
//! sampling), keeping the widget at 128pt.
//!
//! Follows /tmp/zero-native/examples/system-monitor/src/model.zig's
//! timer pattern (`fx.startTimer` `.repeating` + `Effects.timerMsg`),
//! the dynamic-images doc's `fx.loadImage`/`imageUnregister` semantics
//! (Zig-core apps cannot use the TS-only static `assets.images`
//! manifest field), and examples/channel-monitor's external-source
//! channel pattern for the state bridge.

const std = @import("std");
const native_sdk = @import("native_sdk");
const appkit = @import("appkit.zig");
const assets = @import("assets.zig");
const manifest = @import("manifest.zig");
const persist = @import("persist.zig");
const server = @import("server.zig");
const state = @import("state.zig");

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

pub const Mood = state.Mood;

pub const Effects = native_sdk.Effects(Msg);

/// Monotonic milliseconds for drag-rate instrumentation (Zig 0.16 has no
/// std.time.nanoTimestamp; read CLOCK_MONOTONIC directly — macOS-only app).
fn monotonicMs() i128 {
    var ts: std.posix.timespec = undefined;
    switch (std.posix.errno(std.posix.system.clock_gettime(.MONOTONIC, &ts))) {
        .SUCCESS => return @as(i128, ts.sec) * std.time.ms_per_s + @divTrunc(ts.nsec, std.time.ns_per_ms),
        else => return 0,
    }
}

/// The one repeating timer: flips the current strip's frame at the
/// current (pet, mood)'s manifest cadence.
pub const frame_timer_key: u64 = 1;

/// Drag-follow poll timer: 60Hz absolute repositioning independent of
/// the on_drag event stream (which dies when the pointer outruns the
/// 128pt sprite and leaves the window's hit region).
pub const drag_poll_timer_key: u64 = 4;
pub const drag_poll_interval_ms: u32 = 16;

/// The plugin state bridge's external-source channel key. Shares the
/// keyed families' one key space, so it must not collide with the
/// timer keys or the sprite image ids (which start at
/// manifest.image_id_base = 100).
pub const state_channel_key: u64 = 5;

/// Window geometry: the 128pt sprite sits inside a larger transparent
/// window so the zoomed (1.25x) sprite and the hover hit area stay
/// inside the GPU surface — a CAMetalLayer physically cannot paint
/// outside its bounds, which is what clipped the sprite during fast
/// moves at the window's own edges. 32pt margin per side, well under
/// the point where the (click-intercepting) transparent area would
/// feel like dead screen space.
pub const window_size = 192;
pub const sprite_size = 128;
pub const sprite_zoomed_size = 160; // 1.25x cap: overhang 16pt < 32pt margin

/// Bottom-right initial placement margin, matching the Web plugin.
pub const screen_margin: f64 = 24;

/// The pet the app draws when /state names an unknown petId (or none
/// yet): manifest pet 0, the built-in the manifest lists first.
pub const fallback_pet_index: usize = 0;

/// Fallback flip cadence when the manifest failed to load: the pet
/// draws nothing either way, but the timer must still be sane.
pub const fallback_interval_ms: u32 = 250;

/// The one seam tests swap: `boot` starts the HTTP server through this
/// pointer, so unit tests substitute a no-thread recorder (and a
/// failing starter) while the real app spawns src/server.zig's thread.
pub var start_state_server: *const fn (handle: native_sdk.ChannelHandle) std.Thread.SpawnError!void = server.start;

/// The `on_drag` payload record: the runtime injects phase/x/y/view
/// geometry into the authored template (6 fields, exact camelCase names
/// — canvas/ui_markup_reflect.zig declaredWidgetDragDropRecord).
pub const DragRecord = struct {
    sourceId: u64 = 0,
    phase: u8 = 0, // 0 change, 1 end, 2 cancel
    x: f32 = 0,
    y: f32 = 0,
    viewWidth: f32 = 0,
    viewHeight: f32 = 0,
};

pub const StripStatus = enum { unloaded, loading, loaded };

pub const Model = struct {
    /// Current strip playback: active pet (manifest index), mood-driven
    /// strip, and the frame the next view pass crops out of it.
    active_pet: usize = fallback_pet_index,
    mood: Mood = .idle,
    frame_index: u32 = 0,
    /// Per (pet, mood) load bookkeeping. `loading` survives pet
    /// switches ON PURPOSE: re-issuing a load for an id whose load is
    /// still in flight would answer `.rejected` (one load per id), so
    /// switching back to a pet whose strips are mid-load just waits
    /// for the terminals.
    strip_status: [manifest.max_pets][manifest.mood_count]StripStatus = @splat(@splat(.unloaded)),
    strip_width: [manifest.max_pets][manifest.mood_count]u32 = @splat(@splat(0)),
    strip_height: [manifest.max_pets][manifest.mood_count]u32 = @splat(@splat(0)),
    /// False when assets/sprites/manifest.json failed to read/parse at
    /// boot: the bridge still runs, the canvas just draws nothing.
    manifest_ok: bool = false,
    /// Press feedback: toggling zooms the sprite 128 -> 160 -> 128
    /// (1.25x, still inside the window's transparent safety margin).
    zoomed: bool = false,
    press_count: u32 = 0,
    /// Plugin-reported state (src/state.zig). `bridge_live` flips true
    /// on the first delivered state and false on a channel terminal —
    /// the at-a-glance "is the plugin talking to me" signal.
    state_updates: u32 = 0,
    bridge_live: bool = false,
    /// The channel open was rejected, or the server thread failed to
    /// spawn: the app still runs, just without the plugin bridge.
    bridge_failed: bool = false,
    pet_id_storage: [state.max_field_bytes]u8 = undefined,
    pet_id_len: usize = 0,
    pet_name_storage: [state.max_field_bytes]u8 = undefined,
    pet_name_len: usize = 0,
    /// The driving page's language, mirrored from the bridge so the app's
    /// own chrome (the right-click Quit item) speaks it. Persisted with
    /// the rest of the state, so a restart greets in the right language
    /// even before the plugin's first POST.
    locale: state.Locale = .en,
    /// App-owned window drag state (see appkit.zig's doc comment for why
    /// the built-in window_drag channel cannot serve this app). Also
    /// drives the display-layer mood override (see effectiveMood).
    dragging: bool = false,
    drag_events: u32 = 0,
    poll_ticks: u32 = 0,
    /// Mid-drag end/cancel events ignored because the physical button
    /// was still down (runtime cancels the widget drag when the pointer
    /// leaves the window; the poll timer keeps following regardless).
    spurious_ends: u32 = 0,
    drag_start_ms: i128 = 0,
    /// Set by endDrag; the release that ends a drag re-fires a press
    /// (the runtime's terminal drag branch clears the drag state but
    /// not the pressed latch — canvas_widget_events.zig 416-430 — so
    /// the captured pointer_up still dispatches a click). Presses
    /// within this window are the drag's own release echo, not clicks.
    drag_end_ms: i128 = 0,
    /// Absolute screen-space offset from the window's AppKit origin to
    /// the pointer, captured at the drag's first (post-slop) event:
    /// origin = mouseLocation - grab_offset for every later event, so
    /// positioning is an absolute 1:1 mapping with no accumulation and
    /// no view-local feedback loop.
    grab_offset_x: f64 = 0,
    grab_offset_y: f64 = 0,
    /// Facing while carried: every strip is drawn facing LEFT, so a
    /// rightward drag mirrors the sprite horizontally (the view reads
    /// flipSprite). Tracked from pointer x deltas with a dead zone so
    /// sub-pixel jitter doesn't thrash the mirror, and kept across
    /// drags — a carried pet keeps the heading it last ran with.
    facing_right: bool = false,
    last_drag_mouse_x: f64 = 0,

    pub fn petId(model: *const Model) []const u8 {
        return model.pet_id_storage[0..model.pet_id_len];
    }

    pub fn petName(model: *const Model) []const u8 {
        return model.pet_name_storage[0..model.pet_name_len];
    }

    /// What the .state_event handler needs to re-act on: a changed mood
    /// (re-arm the cadence, restart the strip) and/or a changed petId
    /// (swap the whole strip set).
    pub const AppliedState = struct {
        mood: ?Mood = null,
        pet_changed: bool = false,
    };

    /// Apply one decoded channel line. The event's byte slice is drain
    /// scratch and dies with the update call, so the free-text fields
    /// are copied into the model's own storage.
    pub fn applyStateLine(model: *Model, line: []const u8) AppliedState {
        const decoded = state.decodeStateLine(line);
        model.state_updates += 1;
        model.bridge_live = true;
        var applied: AppliedState = .{};
        if (decoded.pet_id.len > 0 and !std.mem.eql(u8, decoded.pet_id, model.petId())) {
            const len = @min(decoded.pet_id.len, state.max_field_bytes);
            @memcpy(model.pet_id_storage[0..len], decoded.pet_id[0..len]);
            model.pet_id_len = len;
            applied.pet_changed = true;
        }
        if (decoded.name.len > 0) {
            // v1 never displays the name; it is bookkeeping only, kept
            // so the run log can show who the plugin thinks we are.
            const len = @min(decoded.name.len, state.max_field_bytes);
            @memcpy(model.pet_name_storage[0..len], decoded.name[0..len]);
            model.pet_name_len = len;
        }
        if (decoded.mood) |mood| {
            if (mood != model.mood) {
                model.mood = mood;
                applied.mood = mood;
            }
        }
        if (decoded.locale) |locale| model.locale = locale;
        return applied;
    }

    /// The current strip's registered image and the current frame's
    /// source crop in DECODED physical pixels (the atlas path: frames
    /// are square, so the decoded height is the frame size; the strip
    /// width divides evenly into `frames` of them). Image id 0 (the
    /// no-image sentinel) until the strip's load lands — the widget
    /// draws nothing yet.
    pub const Sprite = struct {
        image: canvas.ImageId = 0,
        src: ?geometry.RectF = null,
    };

    /// The mood the sprite actually draws: while the window is being
    /// dragged the pet runs (working strip), whatever the bridge last
    /// said. Display-layer override only — `model.mood` keeps tracking
    /// bridge state, so a /state update landing mid-drag is neither
    /// lost nor clobbered when the drag ends; the next sprite() call
    /// after endDrag reflects it.
    pub fn effectiveMood(model: *const Model) Mood {
        return if (model.dragging) .working else model.mood;
    }

    /// True while a rightward drag should mirror the sprite: the run
    /// override is the only directional animation, and every strip is
    /// drawn facing left natively.
    pub fn flipSprite(model: *const Model) bool {
        return model.dragging and model.facing_right;
    }

    pub fn sprite(model: *const Model) Sprite {
        const m = manifest.current() orelse return .{};
        const mood = model.effectiveMood();
        const mood_index = @intFromEnum(mood);
        if (model.strip_status[model.active_pet][mood_index] != .loaded) return .{};
        const height = model.strip_height[model.active_pet][mood_index];
        if (height == 0) return .{};
        const frames = m.strip(model.active_pet, mood).frames;
        if (frames == 0) return .{};
        // A mood change lands between ticks: clamp the index the new
        // (possibly shorter) strip hasn't caught up with yet.
        const frame = @min(model.frame_index, frames - 1);
        const frame_px = manifest.framePixels(height);
        return .{
            .image = manifest.imageId(model.active_pet, mood),
            .src = geometry.RectF.init(manifest.frameOriginX(frame, height), 0, frame_px, frame_px),
        };
    }
};

pub const Msg = union(enum) {
    tick: native_sdk.EffectTimer,
    drag_poll: native_sdk.EffectTimer,
    image_done: native_sdk.EffectImageResult,
    state_event: native_sdk.EffectChannelEvent,
    drag: DragRecord,
    press,
    quit,
};

/// The active (pet, mood)'s manifest cadence, or the fallback when the
/// manifest never loaded.
fn currentIntervalMs(model: *const Model) u32 {
    const m = manifest.current() orelse return fallback_interval_ms;
    return manifest.timerIntervalMs(m.strip(model.active_pet, model.effectiveMood()));
}

/// Re-arm the frame timer at the current strip's cadence. startTimer on
/// an occupied timer key would reject, so the old arm is cancelled first.
fn startFrameTimer(fx: *Effects, interval_ms: u32) void {
    fx.cancelTimer(frame_timer_key);
    fx.startTimer(.{
        .key = frame_timer_key,
        .interval_ms = interval_ms,
        .mode = .repeating,
        .on_fire = Effects.timerMsg(.tick),
    });
}

/// Issue loads for every unloaded strip of the active pet. One load per
/// id at a time is the registry rule, so `loading`/`loaded` strips are
/// skipped — this is also what makes switching BACK to a pet whose
/// strips are mid-flight safe (their terminals finish the job).
fn loadPetSet(model: *Model, fx: *Effects) void {
    const m = manifest.current() orelse return;
    for (0..manifest.mood_count) |mood_index| {
        if (model.strip_status[model.active_pet][mood_index] != .unloaded) continue;
        const entry = m.pets[model.active_pet].strips[mood_index];
        var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
        const path = assets.spritePath(&path_buffer, entry.file) orelse continue;
        fx.loadImage(.{
            .id = manifest.imageId(model.active_pet, @enumFromInt(mood_index)),
            .path = path,
            .on_result = Effects.imageMsg(.image_done),
        });
        model.strip_status[model.active_pet][mood_index] = .loading;
    }
}

/// Swap the whole strip set on a petId change. Loaded strips of the old
/// pet unregister SYNCHRONOUSLY (unregisterImage is registry surgery,
/// not an effect: no terminal follows, and the pixels free immediately);
/// in-flight loads are left alone — pet-scoped ids never collide with
/// the new set, and their terminals take the stale branch in
/// .image_done, which unregisters them on arrival. Net registry use
/// stays at one pet's 8 strips plus transient in-flight stragglers.
fn switchPet(model: *Model, fx: *Effects, new_pet: usize) void {
    if (new_pet == model.active_pet) return;
    for (0..manifest.mood_count) |mood_index| {
        if (model.strip_status[model.active_pet][mood_index] == .loaded) {
            _ = fx.unregisterImage(manifest.imageId(model.active_pet, @enumFromInt(mood_index)));
            model.strip_status[model.active_pet][mood_index] = .unloaded;
        }
    }
    model.active_pet = new_pet;
    model.frame_index = 0;
    loadPetSet(model, fx);
}

/// TEA init: parse the sprite manifest (single source for strip
/// geometry), issue the active pet's strip loads, start the frame timer
/// at the idle cadence, open the state bridge, and place the window
/// bottom-right before the first-present reveal (init_fx runs on the
/// installing frame, ahead of the reveal).
///
/// Place exactly ONCE here: two setFrameOrigin: calls in the same
/// pre-reveal turn leave the composited content one move behind the
/// WindowServer frame record (observed 2026-09-03 in the spike; do not
/// reintroduce).
pub fn boot(model: *Model, fx: *Effects) void {
    // Resolving the assets root here (first assets.* call) also pins it
    // for the HTTP server thread, which starts below and only reads the
    // cached pointer afterwards.
    var manifest_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const manifest_path = assets.assetPath(&manifest_buffer, "sprites/manifest.json") orelse "assets/sprites/manifest.json";
    manifest.load(manifest_path) catch |err| {
        std.debug.print("dsh-pet-desktop: sprite manifest load failed: {s}\n", .{@errorName(err)});
    };
    model.manifest_ok = manifest.current() != null;
    if (manifest.current()) |m| {
        std.debug.print("dsh-pet-desktop: sprite manifest: {d} pet(s) scale={d} frame={d}pt\n", .{ m.pet_count, m.scale, m.frame_size });
    }
    // Greet the user as the pet they last picked, not the fallback:
    // restore BEFORE the first strip load so the restored pet's strips are
    // the ones fetched, and the frame timer below arms at its mood's cadence.
    var saved_buffer: [persist.max_line_bytes]u8 = undefined;
    if (persist.loadStateLine(&saved_buffer)) |line| restoreSavedState(model, line);
    loadPetSet(model, fx);
    startFrameTimer(fx, currentIntervalMs(model));

    // Open the state channel and hand its thread-safe handle to the
    // HTTP server thread. A refused open still answers: exactly one
    // `.rejected` event arrives instead of data, and `handle.live()`
    // gates the spawn (channel-monitor's replay-safety pattern: under
    // session replay the open parks and no thread starts).
    const handle = fx.openChannel(.{
        .key = state_channel_key,
        .on_event = Effects.channelMsg(.state_event),
    });
    if (handle.live()) {
        start_state_server(handle) catch {
            // A bridge whose producer never started must not sit on
            // the key forever: close it so the terminal retires the
            // occupancy, and put the failure in the model.
            model.bridge_failed = true;
            fx.closeChannel(state_channel_key);
        };
    }
    appkit.hideFromDock();
    appkit.placeBottomRight(screen_margin, window_size);
    appkit.logFrame("boot");
}

pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    switch (msg) {
        .tick => |timer| {
            if (timer.outcome != .fired) return;
            const m = manifest.current() orelse return;
            model.frame_index = manifest.nextFrame(model.frame_index, m.strip(model.active_pet, model.effectiveMood()).frames);
        },
        .image_done => |result| {
            const decoded = manifest.decodeImageId(result.id) orelse {
                std.debug.print("dsh-pet-desktop: image_done for unknown id={d}\n", .{result.id});
                return;
            };
            const mood_index = @intFromEnum(decoded.mood);
            if (result.outcome != .loaded) {
                model.strip_status[decoded.pet][mood_index] = .unloaded;
                std.debug.print("dsh-pet-desktop: strip load failed pet={d} mood={s} outcome={s}\n", .{ decoded.pet, @tagName(decoded.mood), @tagName(result.outcome) });
                return;
            }
            if (decoded.pet != model.active_pet) {
                // Stale: the pet was switched away while this load was
                // in flight. Release the slot immediately — an
                // un-unregistered straggler would occupy one of the 16
                // registry slots forever.
                _ = fx.unregisterImage(result.id);
                model.strip_status[decoded.pet][mood_index] = .unloaded;
                std.debug.print("dsh-pet-desktop: stale strip released pet={d} mood={s}\n", .{ decoded.pet, @tagName(decoded.mood) });
                return;
            }
            model.strip_status[decoded.pet][mood_index] = .loaded;
            model.strip_width[decoded.pet][mood_index] = @intCast(result.width);
            model.strip_height[decoded.pet][mood_index] = @intCast(result.height);
            std.debug.print("dsh-pet-desktop: strip loaded pet={d} mood={s} {d}x{d}\n", .{ decoded.pet, @tagName(decoded.mood), result.width, result.height });
        },
        .state_event => |event| switch (event.kind) {
            .data => {
                const applied = model.applyStateLine(event.bytes);
                if (applied.pet_changed) {
                    const new_pet = blk: {
                        const m = manifest.current() orelse break :blk fallback_pet_index;
                        break :blk m.petIndex(model.petId()) orelse {
                            std.debug.print("dsh-pet-desktop: unknown petId \"{s}\", falling back to the first manifest pet\n", .{model.petId()});
                            break :blk fallback_pet_index;
                        };
                    };
                    switchPet(model, fx, new_pet);
                }
                if (applied.mood != null) {
                    // New strip: restart at frame 0 on the new cadence.
                    model.frame_index = 0;
                    startFrameTimer(fx, currentIntervalMs(model));
                }
                // Persist the MERGED state (mood from the model, not the
                // possibly-partial line): a mood-only update must not erase
                // the saved pet id. The next boot greets this pet.
                var save_buffer: [persist.max_line_bytes]u8 = undefined;
                persist.saveStateLine(state.encodeStateLine(&save_buffer, .{
                    .mood = @constCast(@tagName(model.mood)),
                    .pet_id = @constCast(model.petId()),
                    .name = @constCast(model.petName()),
                    .locale = @constCast(@tagName(model.locale)),
                }));
                std.debug.print("dsh-pet-desktop: state #{d} mood={s} pet={s} name={s}\n", .{ model.state_updates, @tagName(model.mood), model.petId(), model.petName() });
            },
            .closed => {
                model.bridge_live = false;
                std.debug.print("dsh-pet-desktop: state channel closed\n", .{});
            },
            .rejected => {
                model.bridge_live = false;
                model.bridge_failed = true;
                std.debug.print("dsh-pet-desktop: state channel rejected\n", .{});
            },
        },
        .press => {
            // A press arriving while the poll still owns the gesture is
            // the drag's own release echo (it precedes the poll's
            // buttons-up detection by <16ms), and one landing just
            // after endDrag is the same echo seen from the other side
            // of the race. The window is consumed on first use so a
            // real click 250ms+ later is never swallowed.
            if (model.dragging) return;
            if (model.drag_end_ms != 0 and monotonicMs() - model.drag_end_ms < 250) {
                model.drag_end_ms = 0;
                std.debug.print("dsh-pet-desktop: press suppressed (post-drag release)\n", .{});
                return;
            }
            model.press_count += 1;
            model.zoomed = !model.zoomed;
            std.debug.print("dsh-pet-desktop: press #{d} zoomed={}\n", .{ model.press_count, model.zoomed });
        },
        // The runtime slop-filters drag gestures (6px): sub-slop motion
        // never reaches us and its release stays an ordinary press, so
        // click-to-zoom and drag-to-move share the surface. A POST-slop
        // drag's release also arrives as a press here (the runtime's
        // terminal branch retires press_target but a mid-flight cancel
        // leaves the pressed latch set — see the .press branch), so the
        // press handler suppresses the drag's own release echo.
        //
        // The drag event stream only STARTS the gesture: events are
        // dispatched through the window's hit region, so once the pointer
        // outruns the sprite and exits the window the stream dies
        // mid-drag (the "pointer escapes on fast moves" bug). Following
        // is owned by the 60Hz poll timer instead — absolute
        // mouseLocation reads that need no events at all.
        .drag => |d| switch (d.phase) {
            0 => {
                if (!model.dragging) {
                    // First (post-slop) change event: capture the
                    // pointer-to-origin offset in ABSOLUTE screen
                    // coordinates so the drag starts with zero jump
                    // (the pre-slop pixels never move the window), then
                    // hand following to the poll timer.
                    const o = appkit.origin() orelse return;
                    const ml = appkit.mouseLocation() orelse return;
                    model.dragging = true;
                    model.drag_events = 0;
                    model.poll_ticks = 0;
                    model.spurious_ends = 0;
                    model.drag_start_ms = monotonicMs();
                    model.grab_offset_x = ml.x - o.x;
                    model.grab_offset_y = ml.y - o.y;
                    // Heading baseline: the first sample anchors the x
                    // delta series, it does not itself flip anything.
                    model.last_drag_mouse_x = ml.x;
                    // Run while carried: restart the strip on the
                    // working cadence (display-layer override, see
                    // effectiveMood — model.mood itself is untouched).
                    model.frame_index = 0;
                    startFrameTimer(fx, currentIntervalMs(model));
                    fx.startTimer(.{
                        .key = drag_poll_timer_key,
                        .interval_ms = drag_poll_interval_ms,
                        .mode = .repeating,
                        .on_fire = Effects.timerMsg(.drag_poll),
                    });
                    return;
                }
                // Late drag events are still applied (same absolute math,
                // extra sub-tick responsiveness) and counted: their rate
                // collapse during fast drags is the evidence for why the
                // poll timer owns following.
                model.drag_events += 1;
                const ml = appkit.mouseLocation() orelse return;
                noteDragPointerX(model, ml.x);
                appkit.setOrigin(dragOrigin(ml, model.grab_offset_x, model.grab_offset_y));
            },
            else => {
                // Drag end/cancel events are ADVISORY. The runtime
                // cancels the widget drag when the pointer leaves the
                // window mid-gesture, but the physical button is still
                // down and the 60Hz poll is still following — trusting
                // the event there kills the poll loop and strands the
                // window (the long-fast-flick escape). Only a physical
                // button-up ends the drag; the poll tick detects it.
                if (appkit.leftMouseDown()) {
                    model.spurious_ends += 1;
                    std.debug.print("dsh-pet-desktop: drag end/cancel ignored (button down) phase={d} events={d} polls={d}\n", .{ d.phase, model.drag_events, model.poll_ticks });
                    return;
                }
                endDrag(model, fx, "event");
            },
        },
        .drag_poll => |timer| {
            if (timer.outcome != .fired) return;
            if (!model.dragging) {
                fx.cancelTimer(drag_poll_timer_key);
                return;
            }
            // Release detection does not depend on the up/end event
            // reaching us: poll the physical button state.
            if (!appkit.leftMouseDown()) {
                endDrag(model, fx, "buttons-up");
                return;
            }
            const ml = appkit.mouseLocation() orelse return;
            noteDragPointerX(model, ml.x);
            appkit.setOrigin(dragOrigin(ml, model.grab_offset_x, model.grab_offset_y));
            model.poll_ticks += 1;
            if (model.poll_ticks % 60 == 0) {
                const elapsed_ms = monotonicMs() - model.drag_start_ms;
                std.debug.print("dsh-pet-desktop: drag poll ticks={d} events={d} elapsed_ms={d} origin=({d:.1},{d:.1})\n", .{ model.poll_ticks, model.drag_events, elapsed_ms, ml.x - model.grab_offset_x, ml.y - model.grab_offset_y });
            }
        },
        .quit => fx.quitApp(),
    }
}

/// Re-apply one persisted bridge line (persist.zig) through the same decode
/// the live bridge uses. Restored from disk, not heard from the plugin — so
/// unlike applyStateLine's live use, the bridge lamp and the update counter
/// go back to untouched afterwards.
fn restoreSavedState(model: *Model, line: []const u8) void {
    const applied = model.applyStateLine(line);
    model.bridge_live = false;
    model.state_updates = 0;
    if (applied.pet_changed) {
        if (manifest.current()) |m| {
            model.active_pet = m.petIndex(model.petId()) orelse fallback_pet_index;
        }
    }
    std.debug.print("dsh-pet-desktop: restored saved state mood={s} pet={s} name={s}\n", .{ @tagName(model.mood), model.petId(), model.petName() });
}

/// Drag teardown shared by the release/cancel event path and the poll
/// timer's button-state path — both stop the 60Hz follow timer.
fn endDrag(model: *Model, fx: *Effects, reason: [*:0]const u8) void {
    if (!model.dragging) return;
    model.dragging = false;
    fx.cancelTimer(drag_poll_timer_key);
    model.drag_end_ms = monotonicMs();
    // Drop the run override: restart at frame 0 on the bridge mood's
    // own cadence (dragging is already false, so currentIntervalMs
    // reads model.mood again — including any /state update that
    // arrived mid-drag).
    model.frame_index = 0;
    startFrameTimer(fx, currentIntervalMs(model));
    const elapsed_ms = model.drag_end_ms - model.drag_start_ms;
    std.debug.print("dsh-pet-desktop: drag end ({s}) events={d} polls={d} spurious_ends={d} elapsed_ms={d}\n", .{ reason, model.drag_events, model.poll_ticks, model.spurious_ends, elapsed_ms });
}

/// Absolute drag mapping. NSEvent.mouseLocation and
/// NSWindow.setFrameOrigin: share ONE coordinate space (global AppKit
/// screen space, bottom-left origin, y-up), so there is NO y-flip
/// anywhere in the drag path: grab = ml - origin at the first post-slop
/// event makes dragOrigin reproduce the current origin exactly (zero
/// jump), and every later event maps pointer motion 1:1 with no
/// accumulation and no view-local feedback.
pub fn dragOrigin(ml: appkit.NSPoint, grab_x: f64, grab_y: f64) appkit.NSPoint {
    return .{ .x = ml.x - grab_x, .y = ml.y - grab_y };
}

/// Pointer jitter below this per sample keeps the previous heading
/// instead of flickering the mirror on every 60Hz poll.
const facing_dead_zone_px: f64 = 1.5;

/// Fold one pointer x sample into the drag heading. Samples come from
/// both the drag event stream and the 60Hz poll, whichever moved last.
fn noteDragPointerX(model: *Model, mouse_x: f64) void {
    const dx = mouse_x - model.last_drag_mouse_x;
    model.last_drag_mouse_x = mouse_x;
    if (@abs(dx) < facing_dead_zone_px) return;
    model.facing_right = dx > 0;
}

test "drag heading follows the pointer x with a dead zone" {
    var model: Model = .{};
    // Not dragging: never mirrored, whatever the heading says.
    try std.testing.expect(!model.flipSprite());
    model.dragging = true;
    model.last_drag_mouse_x = 100;
    try std.testing.expect(!model.flipSprite());
    // Sub-dead-zone jitter keeps the previous heading.
    noteDragPointerX(&model, 100.9);
    try std.testing.expect(!model.flipSprite());
    // A real rightward move mirrors the run strip.
    noteDragPointerX(&model, 108);
    try std.testing.expect(model.facing_right);
    try std.testing.expect(model.flipSprite());
    // Jitter again: heading (and mirror) hold.
    noteDragPointerX(&model, 107.2);
    try std.testing.expect(model.flipSprite());
    // A real leftward move flips back.
    noteDragPointerX(&model, 96);
    try std.testing.expect(!model.flipSprite());
    // Drag over: the mirror drops with the run override even if the
    // last heading was rightward.
    noteDragPointerX(&model, 120);
    model.dragging = false;
    try std.testing.expect(!model.flipSprite());
}

test "drag origin mapping is absolute, unflipped, and jump-free" {
    const origin = appkit.NSPoint{ .x = 1360, .y = 110 };
    const grab = appkit.NSPoint{ .x = 42, .y = 17 };
    // First event: pointer at origin+grab reproduces the origin exactly.
    const first = dragOrigin(.{ .x = origin.x + grab.x, .y = origin.y + grab.y }, grab.x, grab.y);
    try std.testing.expectEqual(origin.x, first.x);
    try std.testing.expectEqual(origin.y, first.y);
    // Pointer delta maps 1:1, same axis orientation on both axes (no flip).
    const moved = dragOrigin(.{ .x = origin.x + grab.x + 10, .y = origin.y + grab.y - 7 }, grab.x, grab.y);
    try std.testing.expectEqual(origin.x + 10, moved.x);
    try std.testing.expectEqual(origin.y - 7, moved.y);
}

test "drag overrides the drawn mood with working without touching bridge state" {
    var model: Model = .{};
    try std.testing.expectEqual(Mood.idle, model.effectiveMood());
    model.mood = .sleeping;
    try std.testing.expectEqual(Mood.sleeping, model.effectiveMood());
    model.dragging = true;
    try std.testing.expectEqual(Mood.working, model.effectiveMood());
    // A /state update arriving mid-drag still lands in model.mood...
    _ = model.applyStateLine("thinking\tblob\t");
    try std.testing.expectEqual(Mood.thinking, model.mood);
    // ...while the drawn mood stays the run override until the drag ends.
    try std.testing.expectEqual(Mood.working, model.effectiveMood());
    model.dragging = false;
    try std.testing.expectEqual(Mood.thinking, model.effectiveMood());
}

test "zoomed sprite stays inside the window's transparent safety margin" {
    // The sprite is centered, so the margin is symmetric; the zoomed
    // overhang beyond the base sprite must never exceed it — that is
    // what kept the enlarged sprite inside the Metal layer's bounds.
    const margin = @divExact(window_size - sprite_size, 2);
    try std.testing.expect(margin >= 24);
    const zoom_overhang = @divExact(sprite_zoomed_size - sprite_size, 2);
    try std.testing.expect(zoom_overhang <= margin);
    try std.testing.expect(window_size > sprite_zoomed_size);
}

test "effect keys never collide with the sprite id namespace" {
    const keys = [_]u64{ frame_timer_key, drag_poll_timer_key, state_channel_key };
    for (keys, 0..) |key, index| {
        for (keys[0..index]) |other| try std.testing.expect(other != key);
        try std.testing.expect(key < manifest.image_id_base);
    }
}

test "applyStateLine copies out of drain scratch and reports mood and pet changes" {
    var model: Model = .{};
    var line_buffer: [256]u8 = undefined;

    const first = state.encodeStateLine(&line_buffer, .{ .mood = @constCast("working"), .pet_id = @constCast("blob"), .name = @constCast("Mochi") });
    const applied_first = model.applyStateLine(first);
    try std.testing.expectEqual(Mood.working, applied_first.mood.?);
    try std.testing.expect(applied_first.pet_changed);
    try std.testing.expect(model.bridge_live);
    try std.testing.expectEqualStrings("blob", model.petId());
    try std.testing.expectEqualStrings("Mochi", model.petName());
    try std.testing.expect(model.state_updates == 1);

    // Same state again: nothing to re-act on, but the update still counts.
    const same = state.encodeStateLine(&line_buffer, .{ .mood = @constCast("working"), .pet_id = @constCast("blob") });
    const applied_same = model.applyStateLine(same);
    try std.testing.expect(applied_same.mood == null);
    try std.testing.expect(!applied_same.pet_changed);
    try std.testing.expect(model.state_updates == 2);

    // A pet change with no mood field: pet_changed only.
    const cat = state.encodeStateLine(&line_buffer, .{ .pet_id = @constCast("cat") });
    const applied_cat = model.applyStateLine(cat);
    try std.testing.expect(applied_cat.pet_changed);
    try std.testing.expect(applied_cat.mood == null);
    try std.testing.expectEqualStrings("cat", model.petId());

    // A partial line keeps the previous identity fields.
    const sad = state.encodeStateLine(&line_buffer, .{ .mood = @constCast("sad") });
    const applied_sad = model.applyStateLine(sad);
    try std.testing.expectEqual(Mood.sad, applied_sad.mood.?);
    try std.testing.expect(!applied_sad.pet_changed);
    try std.testing.expectEqualStrings("cat", model.petId());
}

test "applyStateLine mirrors the page locale, and a locale-less line keeps it" {
    var model: Model = .{};
    try std.testing.expectEqual(state.Locale.en, model.locale);

    var line_buffer: [256]u8 = undefined;
    _ = model.applyStateLine(state.encodeStateLine(&line_buffer, .{ .locale = @constCast("zh") }));
    try std.testing.expectEqual(state.Locale.zh, model.locale);

    // Lines without the field (older plugins, pre-locale saves) never
    // reset an established language.
    _ = model.applyStateLine(state.encodeStateLine(&line_buffer, .{ .mood = @constCast("idle") }));
    try std.testing.expectEqual(state.Locale.zh, model.locale);
}

test "a saved state line restores the last pet and mood without lighting the bridge lamp" {
    var model: Model = .{};
    restoreSavedState(&model, "sleeping\tcat\tMochi");
    try std.testing.expectEqual(Mood.sleeping, model.mood);
    try std.testing.expectEqualStrings("cat", model.petId());
    try std.testing.expectEqualStrings("Mochi", model.petName());
    // Disk is not the bridge: the lamp and the counter stay untouched.
    try std.testing.expect(!model.bridge_live);
    try std.testing.expect(model.state_updates == 0);
    // The effective mood follows the restore (no drag override involved).
    try std.testing.expectEqual(Mood.sleeping, model.effectiveMood());
}

test "a saved line naming an unknown pet keeps the fallback index" {
    var model: Model = .{};
    // No manifest loaded in this test process: the pet index stays put,
    // but the identity fields still restore for the run log.
    restoreSavedState(&model, "idle\tno-such-pet\t");
    try std.testing.expectEqual(fallback_pet_index, model.active_pet);
    try std.testing.expectEqualStrings("no-such-pet", model.petId());
}

test {
    _ = @import("assets.zig");
    _ = @import("state.zig");
    _ = @import("server.zig");
    _ = @import("manifest.zig");
    _ = @import("persist.zig");
    _ = @import("view.zig");
}
