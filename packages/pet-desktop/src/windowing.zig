//! Platform windowing bridge for the chromeless pet window: one
//! platform-neutral API — absolute screen points, window placement, the
//! physical left-button state — over per-OS backends. macOS dispatches
//! to src/appkit.zig (dlsym'd Objective-C, because the AppKit host owns
//! the window); Windows to src/win32.zig (raw user32, because the exe
//! already links it via the SDK's Win32 host). model.zig programs
//! against this file only; appkit.zig's doc comment explains why the
//! drag is app-owned at all.
//!
//! Coordinate spaces differ and callers must not care: AppKit's screen
//! space is bottom-left/y-up, Win32's is top-left/y-down, and every
//! relation in the drag path (origin = pointer − grab) is a 1:1 offset
//! mapping between two points in the SAME space — invariant under the
//! flip. `Point` replaces the leaked appkit.NSPoint at model.zig's
//! call sites.

const std = @import("std");
const builtin = @import("builtin");

const backend = switch (builtin.os.tag) {
    .macos => @import("appkit.zig"),
    .windows => @import("win32.zig"),
    else => @compileError("dsh-pet-desktop: no windowing backend for this OS"),
};

/// An absolute screen-space point. Layout matches both backends'
/// platform structs (AppKit NSPoint, and win32.zig's f64 pair), so the
/// conversions below are field copies, never math.
pub const Point = extern struct { x: f64, y: f64 };
pub const Size = extern struct { width: f64, height: f64 };
pub const Rect = extern struct { origin: Point, size: Size };

/// The window's current screen-space origin (bottom-left y-up on macOS,
/// top-left y-down on Windows).
pub fn origin() ?Point {
    const p = backend.origin() orelse return null;
    return .{ .x = p.x, .y = p.y };
}

/// The window's full screen-space frame — the self report behind
/// logFrame.
pub fn frame() ?Rect {
    const f = backend.frame() orelse return null;
    return .{
        .origin = .{ .x = f.origin.x, .y = f.origin.y },
        .size = .{ .width = f.size.width, .height = f.size.height },
    };
}

/// One-line geometry dump for the run log.
pub fn logFrame(tag: [*:0]const u8) void {
    const f = frame() orelse {
        std.debug.print("dsh-pet-desktop: [{s}] window not found\n", .{tag});
        return;
    };
    std.debug.print("dsh-pet-desktop: [{s}] frame=({d:.1},{d:.1} {d:.1}x{d:.1})\n", .{ tag, f.origin.x, f.origin.y, f.size.width, f.size.height });
}

/// The pointer's absolute screen position, independent of any window —
/// the absolute reference the drag math needs so view-local coordinates
/// (which shift as the window moves under the pointer) never feed back
/// into the positioning.
pub fn mouseLocation() ?Point {
    const p = backend.mouseLocation() orelse return null;
    return .{ .x = p.x, .y = p.y };
}

/// Physical left-button state — the drag-end signal for the poll timer:
/// release events can be lost once the pointer leaves the window, the
/// button state cannot.
pub fn leftMouseDown() bool {
    return backend.leftMouseDown();
}

pub fn setOrigin(point: Point) void {
    backend.setOrigin(.{ .x = point.x, .y = point.y });
}

/// Bracket a drag with whatever timer precision the follow poll needs.
/// Windows raises the process timer resolution (SetTimer otherwise
/// rounds onto a 15.625ms grid — see win32.zig's beginPreciseTimers);
/// macOS needs nothing. Must be paired: one end per begin.
///
/// True when millisecond timers are available for the gesture. The
/// follow does not depend on it — it only tells a drag log which timer
/// grid the poll was actually running on.
pub fn beginPreciseTimers() bool {
    return backend.beginPreciseTimers();
}

pub fn endPreciseTimers() void {
    backend.endPreciseTimers();
}

/// Place the window at the primary screen's bottom-right corner with
/// `margin` points of breathing room, respecting the reserved chrome
/// (macOS visibleFrame excludes the Dock and menu bar; the Win32 work
/// area excludes the taskbar). Called from init_fx, ahead of the
/// first-present reveal, so the window never flashes at the host's
/// default centered placement.
pub fn placeBottomRight(margin: f64, content_size: f64) void {
    backend.placeBottomRight(margin, content_size);
}

/// Drop the app from the platform's app switcher surface (Dock and
/// Cmd+Tab on macOS, the taskbar on Windows). Called once from boot,
/// before the window reveals.
pub fn hideFromDock() void {
    backend.hideFromDock();
}
