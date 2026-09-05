//! dsh-pet-desktop state persistence: the last applied bridge state line,
//! saved to disk so a restarted app greets the user as the pet they last
//! picked — and in the mood it last wore — instead of the fallback pet.
//!
//! The saved payload IS the channel line (`mood\tpetId\tname\tlocale`,
//! state.zig — the locale field is absent on saves from older builds),
//! so restore reuses the exact decode the live bridge uses and the two
//! paths can never disagree about the format. Writes are whole-snapshot
//! (encoded from the model after each applied update), never the raw
//! partial line — a mood-only update would otherwise erase the saved pet
//! id.
//!
//! Pure std, no framework imports, every effect behind an explicit
//! Io + Dir + path so tests serve out of a tmpDir, never a real home.

const std = @import("std");
const builtin = @import("builtin");
const state = @import("state.zig");

/// Env override for the state file location (tests and development).
pub const state_file_env = "DSH_PET_DESKTOP_STATE_FILE";

/// Buffer sizing for one line: two max-length free-text fields, the mood
/// tag, separators, and slack.
pub const max_line_bytes: usize = state.max_field_bytes * 2 + 32;

/// One file inside the platform per-user app-data directory —
/// `%LOCALAPPDATA%\dsh-pet-desktop\` on Windows (null when LOCALAPPDATA
/// is unset), `~/Library/Application Support/dsh-pet-desktop/` otherwise
/// (outside iCloud-synced and sandboxed containers either way).
///
/// Every file the app owns on disk resolves through here, so the state
/// line and the run log always land together — and a platform that needs
/// a different convention (an XDG path for Linux, say) is one edit.
pub fn appDataPath(buffer: []u8, file_name: []const u8) ?[]const u8 {
    switch (builtin.os.tag) {
        .windows => {
            const base_z = std.c.getenv("LOCALAPPDATA") orelse return null;
            return std.fmt.bufPrint(
                buffer,
                "{s}\\dsh-pet-desktop\\{s}",
                .{ std.mem.span(base_z), file_name },
            ) catch null;
        },
        else => {
            const home_z = std.c.getenv("HOME") orelse return null;
            return std.fmt.bufPrint(
                buffer,
                "{s}/Library/Application Support/dsh-pet-desktop/{s}",
                .{ std.mem.span(home_z), file_name },
            ) catch null;
        },
    }
}

/// Where the last state line lives: the env override when set, else
/// `state.txt` in the app-data directory.
pub fn statePath(buffer: []u8) ?[]const u8 {
    if (std.c.getenv(state_file_env)) |override| {
        const value = std.mem.span(override);
        if (value.len > 0) return value;
    }
    return appDataPath(buffer, "state.txt");
}

/// Where a windowed run's log goes (runlog.zig). Deliberately NOT
/// subject to `state_file_env`: pointing the state file at a tmpDir for
/// a test must not drag the log along with it.
pub fn logPath(buffer: []u8) ?[]const u8 {
    return appDataPath(buffer, "dsh-pet-desktop.log");
}

/// Write one line, creating the parent directory first.
pub fn saveStateLineTo(
    io: std.Io,
    dir: std.Io.Dir,
    sub_path: []const u8,
    line: []const u8,
) !void {
    if (std.fs.path.dirname(sub_path)) |parent| {
        // NotDir covers a parent that exists through a symlink (/tmp on
        // macOS): createDirPath chokes on it though the directory is right
        // there. Anything genuinely broken fails again at writeFile.
        dir.createDirPath(io, parent) catch |err| switch (err) {
            error.NotDir, error.PathAlreadyExists => {},
            else => return err,
        };
    }
    try dir.writeFile(io, .{ .sub_path = sub_path, .data = line });
}

/// Read the line into `buffer`; null when there is none or it is unreadable.
/// The caller's decode decides whether the content is valid.
pub fn loadStateLineFrom(
    io: std.Io,
    dir: std.Io.Dir,
    sub_path: []const u8,
    buffer: []u8,
) ?[]const u8 {
    const bytes = dir.readFile(io, sub_path, buffer) catch return null;
    const line = std.mem.trimEnd(u8, bytes, "\r\n");
    return if (line.len == 0) null else line;
}

/// Reported once per run. A save runs on every applied bridge update, so
/// a persistent failure (a read-only app-data directory, a full disk)
/// would otherwise write one line per POST for as long as the pet is up
/// — and the run log has to stay bounded, because a desktop pet's
/// process lifetime is "all day" (runlog.zig).
var save_failure_reported = false;

/// Persist one line at the standard location, best-effort: a failed save is
/// logged, never fatal — state saving must never take the pet down.
pub fn saveStateLine(line: []const u8) void {
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = statePath(&path_buffer) orelse return;
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    saveStateLineTo(threaded.io(), std.Io.Dir.cwd(), path, line) catch |err| {
        if (save_failure_reported) return;
        save_failure_reported = true;
        std.debug.print("dsh-pet-desktop: state save failed: {s} (further failures stay silent)\n", .{@errorName(err)});
    };
}

/// Load the saved line from the standard location; null when absent.
pub fn loadStateLine(buffer: []u8) ?[]const u8 {
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = statePath(&path_buffer) orelse return null;
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    return loadStateLineFrom(threaded.io(), std.Io.Dir.cwd(), path, buffer);
}

test "the default state path lives under the platform app-data directory" {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = statePath(&buffer) orelse return error.TestUnexpectedResult;
    const suffix = if (builtin.os.tag == .windows)
        "\\dsh-pet-desktop\\state.txt"
    else
        "Library/Application Support/dsh-pet-desktop/state.txt";
    try std.testing.expect(std.mem.endsWith(u8, path, suffix));
}

test "the run log sits in the app-data directory beside the state file" {
    var log_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const log = logPath(&log_buffer) orelse return error.TestUnexpectedResult;
    const suffix = if (builtin.os.tag == .windows)
        "\\dsh-pet-desktop\\dsh-pet-desktop.log"
    else
        "Library/Application Support/dsh-pet-desktop/dsh-pet-desktop.log";
    try std.testing.expect(std.mem.endsWith(u8, log, suffix));

    // Same directory as the state file, so the two never drift apart —
    // and asserted against appDataPath rather than statePath, because
    // the log deliberately skips the state file's env override.
    var state_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const state_default = appDataPath(&state_buffer, "state.txt") orelse
        return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings(
        std.fs.path.dirname(state_default).?,
        std.fs.path.dirname(log).?,
    );
}

test "a saved line round-trips through the file, parent dirs created" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var line_buffer: [max_line_bytes]u8 = undefined;
    const line = state.encodeStateLine(&line_buffer, .{
        .mood = @constCast("sleeping"),
        .pet_id = @constCast("ai-sleepy-silver-wolf"),
        .name = @constCast("Mochi"),
    });
    try saveStateLineTo(std.testing.io, tmp.dir, "nested/dir/state.txt", line);

    var read_buffer: [max_line_bytes]u8 = undefined;
    const restored = loadStateLineFrom(std.testing.io, tmp.dir, "nested/dir/state.txt", &read_buffer) orelse
        return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings(line, restored);
    const decoded = state.decodeStateLine(restored);
    try std.testing.expectEqual(state.Mood.sleeping, decoded.mood.?);
    try std.testing.expectEqualStrings("ai-sleepy-silver-wolf", decoded.pet_id);
}

test "a missing or empty file loads as nothing" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var buffer: [max_line_bytes]u8 = undefined;
    try std.testing.expect(loadStateLineFrom(std.testing.io, tmp.dir, "nope.txt", &buffer) == null);

    try saveStateLineTo(std.testing.io, tmp.dir, "empty.txt", "");
    try std.testing.expect(loadStateLineFrom(std.testing.io, tmp.dir, "empty.txt", &buffer) == null);
}
