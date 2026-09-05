//! Per-gesture input diagnostics, compiled out unless `-Ddrag-diag`.
//!
//! The Windows drag-jitter hunt needed to see every hover transition,
//! facing flip, poll tick and move interval — readings that only mean
//! something while you are holding a log next to a stopwatch, and that a
//! shipped pet has no business writing. Two builds of the same source
//! therefore differ in exactly this: the debug package is built with
//! `-Ddrag-diag`, the release package without.
//!
//! Only INPUT diagnostics live here. Lifecycle and failure prints
//! (manifest and strip loads, the state bridge, the loopback server,
//! persistence errors) stay unconditional — those are what a field
//! report needs, and they happen once, not 77 times a second.
//!
//! The gate is `enabled`, a comptime-known bool, so a build without the
//! flag has no branch and no format machinery: the calls and the
//! histogram behind them vanish.

const std = @import("std");
const build_options = @import("build_options");

/// True when this build was asked for input diagnostics.
pub const enabled: bool = build_options.drag_diag;

/// One diagnostic line, prefixed like every other print in the app.
/// A no-op when the flag is off.
pub fn print(comptime fmt: []const u8, args: anytype) void {
    if (!enabled) return;
    std.debug.print("dsh-pet-desktop: " ++ fmt, args);
}
