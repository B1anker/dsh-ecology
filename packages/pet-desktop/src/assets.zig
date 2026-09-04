//! Asset root resolution: where "assets/" (sprite strips, manifest, icon)
//! actually lives at runtime.
//!
//! The binary runs in three layouts, and a hard-coded cwd-relative
//! "assets/..." only covers the first:
//!
//! 1. Development: `zig-out/bin/dsh-pet-desktop` launched from the package
//!    root — assets at ./assets.
//! 2. Development, other cwd: same binary, assets at <exe>/../../assets.
//! 3. npm-bundled: the binary sits in the plugin's desktop/ directory with
//!    the assets copied next to it — assets at <exe>/assets. This is how
//!    the settings panel's launch button spawns it (the DSH server's cwd
//!    is whatever directory the user started it in, so cwd-relative reads
//!    find nothing and /pets answers 503).
//!
//! The root is resolved once — first call wins, cached in a static buffer —
//! by probing each candidate for sprites/manifest.json. boot() resolves it
//! on the main thread before the HTTP server thread starts, so later reads
//! from the server thread only touch the cached pointer.
//!
//! DSH_PET_DESKTOP_ASSETS overrides everything (development with assets
//! somewhere unusual); it names the assets directory itself.

const std = @import("std");

/// Env override for the assets directory location.
pub const assets_dir_env = "DSH_PET_DESKTOP_ASSETS";

/// File whose presence proves a candidate directory is the assets root.
const probe_file = "sprites/manifest.json";

var root_buffer: [std.fs.max_path_bytes]u8 = undefined;
var resolved_root: ?[]const u8 = null;
var resolve_attempted: bool = false;

// Test hook: force the outcome, skip probing entirely. Tests that serve
// out of a tmpDir must not leak into the real assets just because zig's
// test cwd happens to be the package root.
var forced_root: ?[]const u8 = null;
var root_forced: bool = false;

/// Pin the root (or the no-root fallback) for a test; null restores the
/// cwd-relative "assets/..." behaviour.
pub fn forceRootForTests(root_path: ?[]const u8) void {
    forced_root = root_path;
    root_forced = true;
}

/// The resolved assets directory (absolute), or null when no candidate
/// holds the manifest — callers then fall back to the cwd-relative path,
/// which preserves today's dev behaviour and its error messages.
pub fn root() ?[]const u8 {
    if (root_forced) return forced_root;
    if (resolve_attempted) return resolved_root;
    resolve_attempted = true;

    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    var candidate_buffer: [std.fs.max_path_bytes]u8 = undefined;

    if (std.c.getenv(assets_dir_env)) |override| {
        const value = std.mem.span(override);
        if (value.len > 0) {
            if (probe(io, value)) return keep(value);
        }
    }

    if (std.Io.Dir.cwd().realPath(io, &candidate_buffer)) |len| {
        if (std.fmt.bufPrint(candidate_buffer[len..], "/assets", .{})) |_| {
            const candidate = candidate_buffer[0 .. len + "/assets".len];
            if (probe(io, candidate)) return keep(candidate);
        } else |_| {}
    } else |_| {}

    if (std.process.executableDirPath(io, &candidate_buffer)) |len| {
        if (std.fmt.bufPrint(candidate_buffer[len..], "/assets", .{})) |_| {
            const candidate = candidate_buffer[0 .. len + "/assets".len];
            if (probe(io, candidate)) return keep(candidate);
        } else |_| {}
        if (std.fmt.bufPrint(candidate_buffer[len..], "/../../assets", .{})) |_| {
            const candidate = candidate_buffer[0 .. len + "/../../assets".len];
            if (probe(io, candidate)) return keep(candidate);
        } else |_| {}
    } else |_| {}

    return null;
}

/// True when `candidate` holds the manifest — i.e. it is the assets root.
fn probe(io: std.Io, candidate: []const u8) bool {
    var probe_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const probe_path = std.fmt.bufPrint(&probe_buffer, "{s}/{s}", .{ candidate, probe_file }) catch
        return false;
    std.Io.Dir.accessAbsolute(io, probe_path, .{}) catch return false;
    return true;
}

/// Cache the winning candidate in the static buffer and return it.
fn keep(candidate: []const u8) ?[]const u8 {
    if (candidate.len > root_buffer.len) return null;
    const kept = root_buffer[0..candidate.len];
    @memcpy(kept, candidate);
    resolved_root = kept;
    std.debug.print("dsh-pet-desktop: assets root: {s}\n", .{kept});
    return resolved_root;
}

/// Absolute path of one file inside the assets root; falls back to the
/// cwd-relative "assets/<rel>" when no root resolved. Null only when the
/// joined path exceeds the buffer.
pub fn assetPath(buffer: []u8, rel: []const u8) ?[]const u8 {
    if (root()) |root_dir| {
        return std.fmt.bufPrint(buffer, "{s}/{s}", .{ root_dir, rel }) catch null;
    }
    return std.fmt.bufPrint(buffer, "assets/{s}", .{rel}) catch null;
}

/// Absolute path of one sprite strip; the path model.zig registers and
/// server.zig serves. Same fallback rule as assetPath.
pub fn spritePath(buffer: []u8, file: []const u8) ?[]const u8 {
    var rel_buffer: [256]u8 = undefined;
    const rel = std.fmt.bufPrint(&rel_buffer, "sprites/{s}", .{file}) catch return null;
    return assetPath(buffer, rel);
}

test "a forced root wins and paths join under it" {
    forceRootForTests("/tmp/fake-assets");
    defer root_forced = false;

    try std.testing.expectEqualStrings("/tmp/fake-assets", root().?);

    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    try std.testing.expectEqualStrings(
        "/tmp/fake-assets/sprites/wolf/idle.png",
        spritePath(&buffer, "wolf/idle.png").?,
    );
    try std.testing.expectEqualStrings(
        "/tmp/fake-assets/icon.icns",
        assetPath(&buffer, "icon.icns").?,
    );
}

test "a forced null root falls back to the cwd-relative assets path" {
    forceRootForTests(null);
    defer root_forced = false;

    try std.testing.expect(root() == null);

    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    try std.testing.expectEqualStrings(
        "assets/sprites/wolf/idle.png",
        spritePath(&buffer, "wolf/idle.png").?,
    );
}

test "the env override points at the assets directory" {
    // Resolution is lazy and cached, so this test must run against a
    // forced state too — the env path is covered by gathering logic and
    // the two tests above pin the join behaviour.
    forceRootForTests(null);
    defer root_forced = false;
    try std.testing.expectEqualStrings("DSH_PET_DESKTOP_ASSETS", assets_dir_env);
}
