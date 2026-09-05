//! In-process AppKit bridge for the chromeless pet window — the macOS
//! backend behind src/windowing.zig (the Windows backend is
//! src/win32.zig). In-process because the AppKit platform host already
//! links AppKit/libobjc: no sidecar, no host patch.
//!
//! Why this exists: the built-in `window_drag` channel hands the gesture
//! to the platform ONLY when the hit walk finds no press-claiming widget
//! on the route (canvas/widget_routing.zig widgetWindowDragTargetIndexFromNode:
//! `widgetClaimsPress` short-circuits before `isWindowDragRegion`). The
//! pet's whole surface is ALSO its press target (click = zoom feedback),
//! so `window_drag` on the same element never fires — the runtime test
//! "a widget with both a press handler and window_drag keeps its press"
//! pins exactly that precedence. Dragging is therefore app-owned: the
//! view's `on_drag` stream (view-local points, slop-filtered by the
//! runtime) drives `setFrameOrigin:` here through the Objective-C
//! runtime.

const std = @import("std");

pub const NSPoint = extern struct { x: f64, y: f64 };
pub const NSRect = extern struct { origin: NSPoint, size: NSSize };
const NSSize = extern struct { width: f64, height: f64 };

extern "c" fn dlsym(handle: ?*anyopaque, symbol: [*:0]const u8) ?*anyopaque;

/// dlopen's "everything already loaded" pseudo-handle ((void*)-2).
/// libobjc is always in the process — the AppKit platform host links it —
/// so no dlopen call is needed.
const RTLD_DEFAULT: ?*anyopaque = @ptrFromInt(@as(u64, 0xfffffffffffffffe));

var p_objc_getClass: *const fn ([*:0]const u8) callconv(.c) ?*anyopaque = undefined;
var p_sel_registerName: *const fn ([*:0]const u8) callconv(.c) ?*anyopaque = undefined;
var p_objc_msgSend: *const anyopaque = undefined;
var resolved = false;

/// One-time dlsym resolution. Linking libobjc by name fails in this build
/// graph (zig finds no usr/lib search path for the generated modules), and
/// runtime lookup is immune to SDK layout differences anyway. All callers
/// run on the main/UI thread, so the lazy init needs no synchronization.
fn resolve() void {
    if (resolved) return;
    p_objc_getClass = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "objc_getClass").?));
    p_sel_registerName = @ptrCast(@alignCast(dlsym(RTLD_DEFAULT, "sel_registerName").?));
    p_objc_msgSend = dlsym(RTLD_DEFAULT, "objc_msgSend").?;
    resolved = true;
}

fn sel(name: [*:0]const u8) *anyopaque {
    return p_sel_registerName(name).?;
}

// objc_msgSend is a trampoline: one cast per call SHAPE. arm64 needs no
// stret variant — the trampoline preserves the indirect-result register,
// so NSRect-returning calls use the plain symbol too.
fn call0(comptime R: type, receiver: *anyopaque, selector: *anyopaque) R {
    const f: *const fn (*anyopaque, *anyopaque) callconv(.c) R = @ptrCast(@alignCast(p_objc_msgSend));
    return f(receiver, selector);
}

fn call1(comptime R: type, receiver: *anyopaque, selector: *anyopaque, arg: anytype) R {
    const f: *const fn (*anyopaque, *anyopaque, @TypeOf(arg)) callconv(.c) R = @ptrCast(@alignCast(p_objc_msgSend));
    return f(receiver, selector, arg);
}

const window_title = "DSH Pet";

/// NSApplicationActivationPolicy.accessory: no Dock icon, no Cmd+Tab
/// entry, no menu bar — the shape of a menu-bar agent. The pet is
/// summoned and quit from its own window (right-click) and driven from
/// the web page; a Dock presence is clutter for a document-less window.
/// (Regular, the default for a raw executable, is what showed the
/// generic "exec" icon.)
const activation_policy_accessory: i64 = 1;

/// No-ops here: the Windows backend raises the process timer resolution
/// for the duration of a drag because SetTimer rounds onto a 15.625ms
/// grid (win32.zig's beginPreciseTimers explains). Mach timers already
/// deliver the app timer's request, so there is nothing to raise —
/// which is what the `true` reports: millisecond timers are available.
pub fn beginPreciseTimers() bool {
    return true;
}
pub fn endPreciseTimers() void {}

/// Drop the app from the Dock and the Cmd+Tab switcher. Runtime-settable
/// and instant; called once from boot, before the window reveals.
pub fn hideFromDock() void {
    resolve();
    const app_class = p_objc_getClass("NSApplication") orelse return;
    const app = call0(*anyopaque, app_class, sel("sharedApplication"));
    call1(void, app, sel("setActivationPolicy:"), activation_policy_accessory);
}

/// The pet's one NSWindow, found by title through [NSApp windows].
/// A borderless chromeless window keeps its title; transient NSMenu
/// popup windows carry none, so the match is unambiguous in this app.
fn petWindow() ?*anyopaque {
    resolve();
    const app_class = p_objc_getClass("NSApplication") orelse return null;
    const app = call0(*anyopaque, app_class, sel("sharedApplication"));
    const windows = call0(*anyopaque, app, sel("windows"));
    const count = call0(usize, windows, sel("count"));
    var index: usize = 0;
    while (index < count) : (index += 1) {
        const window = call1(*anyopaque, windows, sel("objectAtIndex:"), index);
        const title = call0(?*anyopaque, window, sel("title")) orelse continue;
        const utf8 = call0(?[*:0]const u8, title, sel("UTF8String")) orelse continue;
        if (std.mem.orderZ(u8, utf8, window_title) == .eq) return window;
    }
    return null;
}

/// The window's current AppKit frame origin (bottom-left corner, y-up).
pub fn origin() ?NSPoint {
    const window = petWindow() orelse return null;
    return call0(NSRect, window, sel("frame")).origin;
}

/// The window's full AppKit frame plus its screen's frame — the self
/// report that distinguishes "the host moved/resized the window" from
/// "CGWindowList reports different geometry".
pub fn frame() ?NSRect {
    const window = petWindow() orelse return null;
    return call0(NSRect, window, sel("frame"));
}

/// The pointer's absolute screen position (AppKit bottom-left origin,
/// y-up), independent of any window — the absolute reference the drag
/// math needs so view-local coordinates (which shift as the window
/// moves under the pointer) never feed back into the positioning.
pub fn mouseLocation() ?NSPoint {
    resolve();
    const event_class = p_objc_getClass("NSEvent") orelse return null;
    return call0(NSPoint, event_class, sel("mouseLocation"));
}

/// Physical left-button state from +[NSEvent pressedMouseButtons]
/// (bit 0). The drag-end signal for the poll timer: release events can
/// be lost once the pointer leaves the window, the button state cannot.
pub fn leftMouseDown() bool {
    resolve();
    const event_class = p_objc_getClass("NSEvent") orelse return false;
    const buttons = call0(usize, event_class, sel("pressedMouseButtons"));
    return buttons & 1 != 0;
}

pub fn setOrigin(point: NSPoint) void {
    const window = petWindow() orelse return;
    call1(void, window, sel("setFrameOrigin:"), point);
}

/// Place the window at the primary screen's bottom-right corner with
/// `margin` points of breathing room, using the screen's visibleFrame so
/// the Dock and menu bar are respected. Called from init_fx, which runs
/// on the installing frame BEFORE the first-present reveal, so the
/// window never flashes at the host's default centered placement.
pub fn placeBottomRight(margin: f64, content_size: f64) void {
    const window = petWindow() orelse return;
    // [window screen] is valid once the window is on a screen; fall back
    // to mainScreen for this pre-reveal call.
    const screen = call0(?*anyopaque, window, sel("screen")) orelse blk: {
        const screen_class = p_objc_getClass("NSScreen") orelse return;
        break :blk call0(?*anyopaque, screen_class, sel("mainScreen")) orelse return;
    };
    const visible = call0(NSRect, screen, sel("visibleFrame"));
    const target = NSPoint{
        .x = visible.origin.x + visible.size.width - content_size - margin,
        .y = visible.origin.y + margin,
    };
    std.debug.print("dsh-pet-desktop: place bottom-right ({d:.1},{d:.1}) visibleFrame=({d:.1},{d:.1} {d:.1}x{d:.1})\n", .{ target.x, target.y, visible.origin.x, visible.origin.y, visible.size.width, visible.size.height });
    setOrigin(target);
}
