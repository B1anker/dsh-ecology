//! dsh-pet-desktop: the zero-native desktop pet for the DSH Web surface.
//!
//! A 192x192 transparent, always-on-top, chromeless window whose whole
//! surface is one gpu_surface canvas (premultiplied alpha). The canvas
//! draws the current (petId, mood)'s baked sprite strip — cropped one
//! frame at a time via image_src — flipped at the manifest's cadence
//! (src/manifest.zig), driven by the DSH Web plugin's POSTs to the
//! loopback state server (src/server.zig). Click toggles a 1.25x zoom,
//! right-click carries Quit, and dragging is app-owned: on_drag starts
//! the gesture, then a 60Hz poll timer follows NSEvent.mouseLocation
//! absolutely (src/appkit.zig) until the physical left button releases.
//!
//! WebView-free: no frontend/, no WebViewSource — a pure Zig-core UiApp
//! (modeled on /tmp/zero-native/examples/calculator).

const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;

const model_mod = @import("model.zig");
const view_mod = @import("view.zig");
const assets = @import("assets.zig");

pub const Model = model_mod.Model;
pub const Msg = model_mod.Msg;
pub const update = model_mod.update;
pub const boot = model_mod.boot;
pub const rootView = view_mod.rootView;

pub const canvas_label = "pet-canvas";
pub const window_size: f32 = model_mod.window_size;

const app_permissions = [_][]const u8{ native_sdk.security.permission_command, native_sdk.security.permission_view };

const shell_views = [_]native_sdk.ShellView{
    .{ .label = canvas_label, .kind = .gpu_surface, .fill = true, .role = "Pet canvas", .accessibility_label = "Pet", .gpu_backend = .metal, .gpu_pixel_format = .bgra8_unorm, .gpu_present_mode = .timer, .gpu_alpha_mode = .premultiplied, .gpu_color_space = .srgb, .gpu_vsync = true },
};

// The startup window is created by the host from app.zon's
// `.shell.windows[0]` BEFORE the scene loads; this scene declaration must
// match it (same titlebar/transparent/always_on_top) so the two never
// disagree.
const shell_windows = [_]native_sdk.ShellWindow{.{
    .label = "main",
    .title = "DSH Pet",
    .width = window_size,
    .height = window_size,
    .resizable = false,
    .restore_state = false,
    .restore_policy = .center_on_primary,
    .titlebar = .chromeless,
    .transparent = true,
    .always_on_top = true,
    .views = &shell_views,
}};
pub const shell_scene: native_sdk.ShellConfig = .{ .windows = &shell_windows };

pub const PetApp = native_sdk.UiApp(Model, Msg);

pub fn petOptions() PetApp.Options {
    return .{
        .name = "dsh-pet-desktop",
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .update_fx = update,
        .init_fx = boot,
        .view = rootView,
        .tokens_fn = tokensFromModel,
    };
}

/// The main canvas's frame clear color is the tokens' background
/// (runtime/ui_app.zig handleFrame -> effectiveTokens().colors.background);
/// only model-declared SECONDARY windows get the automatic alpha-0 clear.
/// So a transparent main window must zero its background alpha itself —
/// plus `surface_subtle`/`surface_pressed`: an actionable container's
/// hover/pressed wash reads those rungs (widget_render_style.zig
/// listItemFillColor), and an alpha-0 wash is skipped by the emitter
/// (`background.a <= 0` early-out), keeping every pointer state clear.
fn tokensFromModel(model: *const Model) canvas.DesignTokens {
    _ = model;
    var tokens = canvas.DesignTokens.theme(.{ .color_scheme = .dark });
    tokens.colors.background = .{ .r = 0, .g = 0, .b = 0, .a = 0 };
    tokens.colors.surface_subtle = .{ .r = 0, .g = 0, .b = 0, .a = 0 };
    tokens.colors.surface_pressed = .{ .r = 0, .g = 0, .b = 0, .a = 0 };
    return tokens;
}

pub fn main(init: std.process.Init) !void {
    const app_state = try std.heap.page_allocator.create(PetApp);
    defer std.heap.page_allocator.destroy(app_state);
    app_state.* = PetApp.init(std.heap.page_allocator, .{}, petOptions());
    defer app_state.deinit();
    // The icon lives under the resolved assets root too — this buffer
    // stays alive because runWithOptions blocks for the app's lifetime.
    var icon_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const icon_path = assets.assetPath(&icon_buffer, "icon.icns") orelse "assets/icon.icns";
    try runner.runWithOptions(app_state.app(), .{
        .app_name = "dsh-pet-desktop",
        .window_title = "DSH Pet",
        .bundle_id = "dev.seaveyon.dsh-pet-desktop",
        .icon_path = icon_path,
        .default_frame = geometry.RectF.init(0, 0, window_size, window_size),
        .js_window_api = false,
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{ .allowed_origins = &.{ "zero://inline", "zero://app" } },
        },
    }, init);
}

test "window and canvas labels are consistent" {
    try std.testing.expectEqualStrings("main", shell_scene.windows[0].label);
    try std.testing.expectEqualStrings(canvas_label, shell_scene.windows[0].views[0].label);
    try std.testing.expect(shell_scene.windows[0].transparent);
    try std.testing.expect(shell_scene.windows[0].always_on_top);
}

test {
    _ = @import("model.zig");
}
