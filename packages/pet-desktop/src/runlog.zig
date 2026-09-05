//! Run log for a windowed build: give the process's stderr a file when
//! it has nowhere else to go.
//!
//! The pet ships as a windowed program — a GUI-subsystem exe on Windows,
//! a `.app` bundle on macOS (`zig build package`) — and a run started by
//! double-click has no console. Every `std.debug.print` in the app and
//! in the SDK then vanishes, which is why collecting the drag
//! diagnostics used to mean launching through
//! `cmd /c "pet.exe > log.txt 2>&1"` every single time.
//!
//! A run that already HAS somewhere to write — a console, a terminal, or
//! that shell redirection — keeps it, so the development workflow is
//! untouched and no run splits its output across two sinks.
//!
//! **The two platforms need different questions asked**, which is the
//! whole reason this file is not one branch:
//!
//! - Windows hands a detached process a NULL std handle, so "can I write
//!   to stderr" answers itself: `GetStdHandle` returns null and writes
//!   fail.
//! - macOS hands a Finder-launched `.app` a perfectly VALID fd 2 that
//!   points at `/dev/null` (measured: `st_rdev` equals `/dev/null`'s and
//!   `write` returns the byte count). "Can I write" answers *yes* there
//!   and would skip the redirect, so the question has to be "is stderr
//!   the bit bucket".
//!
//! Redirecting works because `std.Io.File.stderr()` resolves the
//! platform's stderr afresh — `peb().ProcessParameters.hStdError`, which
//! is exactly the field `SetStdHandle` updates, and `STDERR_FILENO`,
//! which is what `dup2` rebinds. Do it before the first print and every
//! later one follows, the SDK's included. It also means neither
//! platform needs to remember the file: the std handle IS the file, so
//! the cap below reads its size straight back off stderr.
//!
//! Size: the file is truncated per run, and a shipped build has no
//! recurring writer left (the per-POST `state #N` line is behind
//! `-Ddrag-diag`, and the two error paths that ride the same POST report
//! once — see persist.zig and model.zig). Measured: 15 lines / 987 bytes
//! after boot, flat from there.
//!
//! That holds **only for a `-Dtrace=off` build**. The SDK's `-Dtrace`
//! defaults to `.events` and writes a line per dispatched event —
//! including one per presented frame — which turns this file into an
//! unbounded one at roughly 5KB a second. Packaged builds must carry
//! `-Dtrace=off` (they do; see the docs' build quick reference).
//!
//! `enforceCap` is the backstop for getting that flag wrong, because
//! none of the cheaper guards exist: the app's build.zig cannot read
//! `-Dtrace` (declaring the option a second time panics), the SDK keeps
//! the value in its own build options with no accessor, and its
//! `StdoutTraceSink` writes through `std.debug.print` — stderr, the same
//! stream as ours — so the two cannot be separated by stream either.

const std = @import("std");
const builtin = @import("builtin");
const persist = @import("persist.zig");

/// Hard ceiling on one run's log. A `-Dtrace=off` build settles around
/// 1KB and never moves, so reaching this at all means something is
/// writing that should not be.
///
/// Enforced to within one frame tick's worth of writes: measured with a
/// deliberately tiny ceiling and a `-Dtrace` flood, the file stopped
/// 332 bytes over and stayed there for the rest of the run.
pub const max_bytes: u64 = 1024 * 1024;

/// Send stdout and stderr to the app-data directory's
/// `dsh-pet-desktop.log` when they have nowhere to write. Best-effort
/// and silent: there is nowhere to report a failure TO, and a run
/// without a log is still a run. Call before anything prints, or the
/// first lines go to the void.
pub fn redirectIfDetached() void {
    switch (builtin.os.tag) {
        .windows => windowsRedirect(),
        .macos => macosRedirect(),
        else => {},
    }
}

/// Cap state. Only ever touched from the UI thread — the redirect runs
/// before any thread is spawned, and `enforceCap` rides the frame timer
/// — so plain globals are the honest representation.
var redirected = false;
var redirected_stdout = false;
var capped = false;

/// Stop the log at `max_bytes`, keeping the HEAD: the boot lines are the
/// part worth reading, and whatever is flooding past them is noise by
/// definition. Once tripped, stderr goes to the null device rather than
/// nowhere, so writes keep succeeding for callers that never check —
/// the pet must not change behaviour because a log filled up.
///
/// Checked on every call rather than on a throttle. The caller is the
/// frame timer, whose cadence is the manifest's — measured at 1100ms
/// while idle, 120ms at the fastest — so this is a handful of `fstat`s
/// per second at worst, against a cap that a throttle would let
/// overshoot by however much a flood writes between checks.
///
/// A no-op unless we own the file: a run with a real console or a shell
/// redirection is the user's to manage.
pub fn enforceCap() void {
    if (!redirected or capped) return;
    const size = logSize() orelse return;
    if (size < max_bytes) return;

    capped = true;
    // The last line the file gets, and it names the likely cause: a
    // -Dtrace build is the only thing that reaches a megabyte.
    std.debug.print(
        "dsh-pet-desktop: run log hit its {d}KB cap and stops here (a -Dtrace build floods it — see src/runlog.zig)\n",
        .{max_bytes / 1024},
    );
    discardFurtherOutput();
}

/// The log path with its parent directory created, NUL-terminated for
/// the platform open call. Null when there is no app-data location (a
/// missing LOCALAPPDATA or HOME) or the directory cannot be made.
fn preparedLogPath(buffer: *[std.fs.max_path_bytes]u8) ?[:0]const u8 {
    // Reserve the last byte so the sentinel always has room.
    const path = persist.logPath(buffer[0 .. buffer.len - 1]) orelse return null;

    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    if (std.fs.path.dirname(path)) |parent| {
        // Same tolerance as persist.saveStateLineTo: NotDir covers a
        // parent reached through a symlink, and an existing directory is
        // the normal case from the second run on.
        std.Io.Dir.cwd().createDirPath(threaded.io(), parent) catch |err| switch (err) {
            error.NotDir, error.PathAlreadyExists => {},
            else => return null,
        };
    }

    buffer[path.len] = 0;
    return buffer[0..path.len :0];
}

fn logSize() ?u64 {
    switch (builtin.os.tag) {
        .windows => {
            const handle = GetStdHandle(std_error_handle) orelse return null;
            var size: i64 = 0;
            if (GetFileSizeEx(handle, &size) == 0) return null;
            if (size < 0) return null;
            return @intCast(size);
        },
        .macos => {
            var info: std.c.Stat = undefined;
            if (std.c.fstat(std.posix.STDERR_FILENO, &info) != 0) return null;
            if (info.size < 0) return null;
            return @intCast(info.size);
        },
        else => return null,
    }
}

fn discardFurtherOutput() void {
    switch (builtin.os.tag) {
        .windows => {
            const nul = CreateFileA(
                "NUL",
                generic_write,
                file_share_read_write,
                null,
                open_existing,
                file_attribute_normal,
                null,
            ) orelse return;
            if (@intFromPtr(nul) == invalid_handle) return;
            _ = SetStdHandle(std_error_handle, nul);
            if (redirected_stdout) _ = SetStdHandle(std_output_handle, nul);
        },
        .macos => {
            const nul = std.c.open("/dev/null", .{ .ACCMODE = .WRONLY });
            if (nul < 0) return;
            defer _ = std.c.close(nul);
            _ = std.c.dup2(nul, std.posix.STDERR_FILENO);
            if (redirected_stdout) _ = std.c.dup2(nul, std.posix.STDOUT_FILENO);
        },
        else => {},
    }
}

// --- Windows ---------------------------------------------------------

const HANDLE = *anyopaque;
const BOOL = c_int;
const DWORD = c_uint;

extern "c" fn GetStdHandle(nStdHandle: DWORD) ?HANDLE;
extern "c" fn SetStdHandle(nStdHandle: DWORD, hHandle: HANDLE) BOOL;
extern "c" fn GetFileSizeEx(hFile: HANDLE, lpFileSize: *i64) BOOL;
extern "c" fn CreateFileA(
    lpFileName: [*:0]const u8,
    dwDesiredAccess: DWORD,
    dwShareMode: DWORD,
    lpSecurityAttributes: ?*anyopaque,
    dwCreationDisposition: DWORD,
    dwFlagsAndAttributes: DWORD,
    hTemplateFile: ?HANDLE,
) ?HANDLE;

const std_output_handle: DWORD = 0xFFFF_FFF5; // (DWORD)-11
const std_error_handle: DWORD = 0xFFFF_FFF4; // (DWORD)-12
const invalid_handle: usize = std.math.maxInt(usize); // (HANDLE)-1

const generic_write: DWORD = 0x4000_0000;
/// Shared both ways: the user tails the log while the pet still holds it
/// open, and a second instance must not fail to open its own.
const file_share_read_write: DWORD = 0x0000_0001 | 0x0000_0002;
const create_always: DWORD = 2; // truncate: one run, one log
const open_existing: DWORD = 3; // for "NUL", which always exists
const file_attribute_normal: DWORD = 0x0000_0080;

/// A std handle we can actually write to. A GUI-subsystem process
/// started from Explorer has null here; one started under a console or
/// with shell redirection has a real handle.
fn usableStdHandle(which: DWORD) bool {
    const handle = GetStdHandle(which) orelse return false;
    return @intFromPtr(handle) != invalid_handle;
}

fn windowsRedirect() void {
    if (usableStdHandle(std_error_handle)) return;

    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = preparedLogPath(&path_buffer) orelse return;

    const log = CreateFileA(
        path.ptr,
        generic_write,
        file_share_read_write,
        null,
        create_always,
        file_attribute_normal,
        null,
    ) orelse return;
    if (@intFromPtr(log) == invalid_handle) return;

    if (SetStdHandle(std_error_handle, log) == 0) return;
    redirected = true;
    // stdout too: the SDK's trace sink and any host printf land there.
    if (!usableStdHandle(std_output_handle)) {
        redirected_stdout = SetStdHandle(std_output_handle, log) != 0;
    }
}

// --- macOS -----------------------------------------------------------

/// `/dev/null`'s device number, read by opening it rather than by
/// `stat`: `std.c.stat` does not resolve on macOS in Zig 0.16 (it maps
/// to a `private.stat` that darwin, with its `stat$INODE64` symbol, does
/// not provide).
fn devNullRdev() ?@FieldType(std.c.Stat, "rdev") {
    const fd = std.c.open("/dev/null", .{ .ACCMODE = .WRONLY });
    if (fd < 0) return null;
    defer _ = std.c.close(fd);
    var info: std.c.Stat = undefined;
    if (std.c.fstat(fd, &info) != 0) return null;
    return info.rdev;
}

/// True when this descriptor is the bit bucket launchd hands a
/// double-clicked `.app`. A tty or a redirected file is somewhere real,
/// and a descriptor that cannot even be stat'd is somewhere unusable.
fn isDevNull(fd: c_int) bool {
    var info: std.c.Stat = undefined;
    if (std.c.fstat(fd, &info) != 0) return true;
    const null_rdev = devNullRdev() orelse return false;
    return info.rdev == null_rdev;
}

fn macosRedirect() void {
    if (!isDevNull(std.posix.STDERR_FILENO)) return;

    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = preparedLogPath(&path_buffer) orelse return;

    // Truncate to match the Windows CREATE_ALWAYS: one run, one log.
    const fd = std.c.open(
        path.ptr,
        .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true },
        @as(std.c.mode_t, 0o644),
    );
    if (fd < 0) return;
    // Closing our copy is safe: the dup2'd descriptors below hold the
    // file for the process's lifetime, and fd 2 is what logSize reads.
    defer _ = std.c.close(fd);

    if (std.c.dup2(fd, std.posix.STDERR_FILENO) < 0) return;
    redirected = true;
    if (isDevNull(std.posix.STDOUT_FILENO)) {
        redirected_stdout = std.c.dup2(fd, std.posix.STDOUT_FILENO) >= 0;
    }
}
