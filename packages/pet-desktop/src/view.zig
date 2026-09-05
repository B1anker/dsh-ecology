//! dsh-pet-desktop view: one centered, atlas-cropped image inside a root
//! container that is the press target, the drag source, and the
//! context-menu owner.
//!
//! The sprite widget binds the current (pet, mood) strip's ImageId and
//! crops the current frame out of it with `image_src` in decoded
//! physical pixels (256px frames at the manifest's scale=2); the widget
//! itself stays 128pt (160pt zoomed). Until the strip's load lands the
//! id is 0 — the no-image sentinel — and the widget draws nothing.
//!
//! Drag is app-owned (`on_drag` + src/windowing.zig), NOT the built-in
//! `window_drag` channel: that channel refuses any element whose hit
//! route contains a press claimer, and this root IS the press claimer
//! (click = zoom feedback) — see appkit.zig's doc comment. The runtime's
//! 6px slop keeps the two gestures disambiguated.
//!
//! `quiet_hover` removes the actionable-container hover wash (an
//! actionable flow container otherwise paints the list-row hover/pressed
//! ladder over its full hit frame — on a transparent window that reads
//! as an opaque square; the pressed rung is silenced token-side in
//! main.zig's tokens_fn).

const std = @import("std");
const native_sdk = @import("native_sdk");
const model_mod = @import("model.zig");
const state = @import("state.zig");

const canvas = native_sdk.canvas;

pub const Model = model_mod.Model;
pub const Msg = model_mod.Msg;
pub const Ui = canvas.Ui(Msg);

const quit_menu_en = [_]Ui.ContextMenuItem{
    .{ .label = "Quit DSH Pet", .msg = .quit },
};

const quit_menu_zh = [_]Ui.ContextMenuItem{
    .{ .label = "退出 DSH Pet", .msg = .quit },
};

/// The one context menu, in the driving page's language (model.locale is
/// mirrored from the bridge and persisted across restarts).
pub fn quitMenu(locale: state.Locale) []const Ui.ContextMenuItem {
    return switch (locale) {
        .zh => &quit_menu_zh,
        .en => &quit_menu_en,
    };
}

pub fn rootView(ui: *Ui, model: *const Model) Ui.Node {
    const size: f32 = if (model.zoomed) model_mod.sprite_zoomed_size else model_mod.sprite_size;
    const sprite = model.sprite();
    // Rightward drags mirror the (natively left-facing) run strip, by one
    // of two paths:
    //  1. Preferred: model.sprite() already swapped in the pet's
    //     pre-mirrored working strip (manifest mirroredFile, stride slot
    //     8) — NO transform needed, so this works on every renderer.
    //  2. Fallback (imported pets without a mirrored strip): the legacy
    //     negative-scale Affine below. Metal honors it; the SDK's
    //     software reference renderer — which Windows transparent windows
    //     ALWAYS take — applies transforms via transformRect's
    //     axis-aligned bounding box and drops the negative-scale sign
    //     (reference.zig drawImage), so there the sprite stays unflipped,
    //     exactly as before the mirrored strips existed. See
    //     docs/zero-native-notes.md, the 2026-09-05 entry.
    // The sprite is always centered in the fixed-width window — zooming
    // grows it symmetrically — so the mirror pivot is simply the
    // window's own width: x' = window_size - x. ty carries the hover
    // hop's lift (0 when standing).
    const lift = model.jumpOffset();
    const flip: canvas.Affine = if (model.flipSprite() and !model.mirroredRunLoaded())
        .{ .a = -1, .tx = model_mod.window_size, .ty = lift }
    else
        .{ .ty = lift };
    return ui.column(.{
        .grow = 1,
        .main = .center,
        .cross = .center,
        .on_press = .press,
        .on_hover_enter = .hover_enter,
        .on_hover_leave = .hover_leave,
        .on_drag = Msg{ .drag = .{ .sourceId = 1 } },
        .context_menu = quitMenu(model.locale),
        .style = .{ .quiet_hover = true },
        .semantics = .{ .label = "Pet" },
    }, .{
        ui.image(.{
            .image = sprite.image,
            .image_src = sprite.src,
            .width = size,
            .height = size,
            .transform = flip,
            .semantics = .{ .label = "Pet sprite" },
        }),
    });
}

test "the quit menu follows the mirrored page locale" {
    const en = quitMenu(.en);
    try std.testing.expectEqualStrings("Quit DSH Pet", en[0].label);
    const zh = quitMenu(.zh);
    try std.testing.expectEqualStrings("退出 DSH Pet", zh[0].label);
    // Same message either way: the locale changes the label, never the act.
    try std.testing.expect(std.meta.eql(en[0].msg, zh[0].msg));
}
