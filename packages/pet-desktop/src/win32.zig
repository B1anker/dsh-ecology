//! In-process Win32 bridge for the chromeless pet window — the Windows
//! counterpart of src/appkit.zig, reached through src/windowing.zig.
//! Direct user32 externs: the exe already links user32 (the SDK's Win32
//! host, src/platform/windows/webview2_host.cpp, owns the window), so no
//! import library or sidecar is needed. appkit.zig's doc comment
//! explains why dragging is app-owned in the first place; this file is
//! only the transport.
//!
//! Coordinates here are the Win32 screen space (top-left origin,
//! y-down) — the mirror image of AppKit's, and irrelevant to callers:
//! the drag math is a pure 1:1 offset mapping between two points in the
//! same space, invariant under the flip (see windowing.zig).
//!
//! Everything below is verified by cross-compilation only, not on real
//! hardware — the layered-window host (WS_EX_LAYERED +
//! UpdateLayeredWindow) and these calls deserve an on-device pass
//! before a Windows release.

const std = @import("std");

pub const Point = extern struct { x: f64, y: f64 };
pub const Rect = extern struct { origin: Point, size: Size };
pub const Size = extern struct { width: f64, height: f64 };

const HWND = *anyopaque;
const BOOL = c_int;
const RECT = extern struct { left: i32, top: i32, right: i32, bottom: i32 };
const POINT = extern struct { x: i32, y: i32 };

extern "c" fn FindWindowA(lpClassName: ?[*:0]const u8, lpWindowName: ?[*:0]const u8) ?HWND;
extern "c" fn GetWindowRect(hWnd: HWND, lpRect: *RECT) BOOL;
extern "c" fn SetWindowPos(hWnd: HWND, hWndInsertAfter: ?HWND, x: c_int, y: c_int, cx: c_int, cy: c_int, uFlags: c_uint) BOOL;
extern "c" fn GetCursorPos(lpPoint: *POINT) BOOL;
extern "c" fn GetAsyncKeyState(vKey: c_int) i16;
extern "c" fn SystemParametersInfoA(uiAction: c_uint, uiParam: c_uint, pvParam: ?*anyopaque, fWinIni: c_uint) BOOL;
extern "c" fn GetWindowLongPtrA(hWnd: HWND, nIndex: c_int) isize;
extern "c" fn SetWindowLongPtrA(hWnd: HWND, nIndex: c_int, dwNewLong: isize) isize;

const window_title = "DSH Pet";

/// The pet's one window, found by title — mirrors appkit.zig's match
/// through [NSApp windows]. The chromeless host window keeps its title;
/// the TrackPopupMenu context menus are transient and untitled, so the
/// match is unambiguous in this app.
fn petWindow() ?HWND {
    return FindWindowA(null, window_title);
}

/// The window's current screen-space origin (top-left corner, y-down).
pub fn origin() ?Point {
    const f = frame() orelse return null;
    return f.origin;
}

/// The window's full screen-space frame.
pub fn frame() ?Rect {
    const window = petWindow() orelse return null;
    var r: RECT = undefined;
    if (GetWindowRect(window, &r) == 0) return null;
    return .{
        .origin = .{ .x = @floatFromInt(r.left), .y = @floatFromInt(r.top) },
        .size = .{ .width = @floatFromInt(r.right - r.left), .height = @floatFromInt(r.bottom - r.top) },
    };
}

/// The pointer's absolute screen position (GetCursorPos), independent
/// of any window — the absolute reference the drag math needs so
/// view-local coordinates never feed back into the positioning.
pub fn mouseLocation() ?Point {
    var p: POINT = undefined;
    if (GetCursorPos(&p) == 0) return null;
    return .{ .x = @floatFromInt(p.x), .y = @floatFromInt(p.y) };
}

const vk_lbutton: c_int = 0x01;

/// Physical left-button state from GetAsyncKeyState(VK_LBUTTON) — the
/// drag-end signal for the poll timer, same role as
/// +[NSEvent pressedMouseButtons] on macOS: release events can be lost
/// once the pointer leaves the window, the button state cannot.
pub fn leftMouseDown() bool {
    // The high bit reports "currently down" (the low bit is a
    // since-last-call latch the drag path must not consult).
    return @as(u16, @bitCast(GetAsyncKeyState(vk_lbutton))) & 0x8000 != 0;
}

// SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE: move only — the size is
// host-fixed, the z-order already carries WS_EX_TOPMOST, and activating
// a chromeless pet window on every poll tick would steal focus.
const swp_move_only: c_uint = 0x0001 | 0x0004 | 0x0010;

pub fn setOrigin(point: Point) void {
    const window = petWindow() orelse return;
    _ = SetWindowPos(window, null, @intFromFloat(@round(point.x)), @intFromFloat(@round(point.y)), 0, 0, swp_move_only);
}

const spi_getworkarea: c_uint = 0x0030;

/// Place the window at the primary screen's bottom-right corner with
/// `margin` pixels of breathing room, using SPI_GETWORKAREA so the
/// taskbar is respected — the Win32 counterpart of appkit.zig's
/// visibleFrame placement. Called from init_fx, before the
/// first-present reveal. (Windows placement is in physical pixels; the
/// host's 192x192 window at 100% scaling matches the point size — the
/// DPI interplay needs on-hardware verification.)
pub fn placeBottomRight(margin: f64, content_size: f64) void {
    var work: RECT = undefined;
    if (SystemParametersInfoA(spi_getworkarea, 0, &work, 0) == 0) return;
    const target = Point{
        .x = @as(f64, @floatFromInt(work.right)) - content_size - margin,
        .y = @as(f64, @floatFromInt(work.bottom)) - content_size - margin,
    };
    std.debug.print("dsh-pet-desktop: place bottom-right ({d:.1},{d:.1}) workArea=({d},{d} {d}x{d})\n", .{ target.x, target.y, work.left, work.top, work.right - work.left, work.bottom - work.top });
    setOrigin(target);
}

const gwl_exstyle: c_int = -20;
const ws_ex_toolwindow: isize = 0x00000080;
const ws_ex_appwindow: isize = 0x00040000;

/// Drop the chromeless pet from the taskbar: WS_EX_TOOLWINDOW keeps a
/// window out of the taskbar and Alt+Tab, WS_EX_APPWINDOW would force
/// it in. The counterpart of appkit.zig's accessory activation policy.
/// Best-effort: a failed style flip leaves a taskbar entry, never a
/// broken window — and it runs before the reveal, so no
/// SWP_FRAMECHANGED re-show dance is needed. Needs on-hardware
/// verification.
pub fn hideFromDock() void {
    const window = petWindow() orelse return;
    const style = GetWindowLongPtrA(window, gwl_exstyle);
    if (style == 0) return;
    const next = (style | ws_ex_toolwindow) & ~ws_ex_appwindow;
    if (next != style) _ = SetWindowLongPtrA(window, gwl_exstyle, next);
}
