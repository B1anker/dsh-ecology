//! dsh-pet view: one centered, atlas-cropped image inside a root
//! container that is the press target, the drag source, and the
//! context-menu owner.
//!
//! The sprite widget binds the current (pet, mood) strip's ImageId and
//! crops the current frame out of it with `image_src` in decoded
//! physical pixels (256px frames at the manifest's scale=2); the widget
//! itself stays 128pt (160pt zoomed). Until the strip's load lands the
//! id is 0 — the no-image sentinel — and the widget draws nothing.
//!
//! Drag is app-owned (`on_drag` + src/appkit.zig), NOT the built-in
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

const canvas = native_sdk.canvas;

pub const Model = model_mod.Model;
pub const Msg = model_mod.Msg;
pub const Ui = canvas.Ui(Msg);

const quit_menu = [_]Ui.ContextMenuItem{
    .{ .label = "Quit DSH Pet", .msg = .quit },
};

pub fn rootView(ui: *Ui, model: *const Model) Ui.Node {
    const size: f32 = if (model.zoomed) model_mod.sprite_zoomed_size else model_mod.sprite_size;
    const sprite = model.sprite();
    return ui.column(.{
        .grow = 1,
        .main = .center,
        .cross = .center,
        .on_press = .press,
        .on_drag = Msg{ .drag = .{ .sourceId = 1 } },
        .context_menu = &quit_menu,
        .style = .{ .quiet_hover = true },
        .semantics = .{ .label = "Pet" },
    }, .{
        ui.image(.{
            .image = sprite.image,
            .image_src = sprite.src,
            .width = size,
            .height = size,
            .semantics = .{ .label = "Pet sprite" },
        }),
    });
}
