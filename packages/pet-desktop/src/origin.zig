//! Which browser origins may drive the state bridge (server.zig).
//!
//! The bridge listens on loopback, but "loopback" only says which machine
//! a request comes from, not which page. Every page open in the user's
//! browser can reach 127.0.0.1:45731, and with the old blanket
//! `access-control-allow-origin: *` any of them could repaint the pet,
//! read its name, enumerate the imported pets, and watch the liveness
//! stream to learn whether the app is running. So the origin is checked:
//!
//!   * a loopback origin (`http(s)://localhost`, `127.0.0.1`, `[::1]`, any
//!     port) is always allowed — that is where a locally served DSH shell
//!     lives, including a double-clicked app that was given no
//!     configuration at all;
//!   * `DSH_PET_DESKTOP_ORIGINS`, a comma-separated list of exact origins,
//!     adds the shell's origin when it is not loopback — a reverse proxy
//!     on the same machine, a LAN hostname. The plugin's launch route sets
//!     it from the page that asked for the launch, so the common path
//!     needs no hand configuration;
//!   * everything else — another site, a `null` origin, a host that merely
//!     starts with `127.0.0.1` — gets no CORS grant, and a POST carrying
//!     it is refused outright (403) so a form-encoded "simple request"
//!     cannot side-step the preflight.
//!
//! A request without an Origin header is not a browser (curl, the tests)
//! and is left alone: CORS is a browser protocol.
//!
//! The configured list is read once at server start and never written
//! again, so the server's per-connection threads read it without a lock.

const std = @import("std");

pub const env_name = "DSH_PET_DESKTOP_ORIGINS";
/// Longest Origin header value considered; anything longer is refused
/// unread. Real origins are a few dozen bytes.
pub const max_origin_bytes: usize = 256;
/// Entries kept from the environment list; extras are dropped with a note.
pub const max_configured: usize = 16;

var configured_storage: [max_configured][]const u8 = undefined;
var configured: []const []const u8 = &.{};

/// Take the allow-list from `DSH_PET_DESKTOP_ORIGINS`. Called once by the
/// server thread before it listens. Values are slices into the process
/// environment, which outlives every request.
pub fn configureFromEnv() void {
    if (std.c.getenv(env_name)) |raw| {
        configure(std.mem.span(raw));
    } else {
        configure(null);
    }
}

/// Parse a comma-separated list of exact origins; whitespace around each
/// entry is ignored, empty entries are skipped. `null` clears the list.
/// The slices must outlive the server.
pub fn configure(list: ?[]const u8) void {
    var count: usize = 0;
    if (list) |value| {
        var parts = std.mem.splitScalar(u8, value, ',');
        while (parts.next()) |part| {
            const entry = std.mem.trim(u8, part, " \t\r\n");
            if (entry.len == 0) continue;
            if (count == max_configured) {
                std.debug.print("dsh-pet-desktop: {s} lists more than {d} origins; the rest are ignored\n", .{ env_name, max_configured });
                break;
            }
            if (!looksLikeOrigin(entry)) {
                std.debug.print("dsh-pet-desktop: {s} entry is not an origin and is ignored: {s}\n", .{ env_name, entry });
                continue;
            }
            configured_storage[count] = entry;
            count += 1;
        }
    }
    configured = configured_storage[0..count];
}

/// The origins currently configured, for logging and tests.
pub fn configuredOrigins() []const []const u8 {
    return configured;
}

/// Whether a request carrying this Origin may use the bridge.
pub fn isAllowed(origin_value: []const u8) bool {
    if (origin_value.len == 0 or origin_value.len > max_origin_bytes) return false;
    for (configured) |entry| {
        if (std.mem.eql(u8, entry, origin_value)) return true;
    }
    return isLoopback(origin_value);
}

/// `scheme://host[:port]` with an http(s) scheme and a loopback host.
/// Exact structural match — no path, no userinfo, no trailing slash — the
/// way browsers serialize the Origin header.
pub fn isLoopback(origin_value: []const u8) bool {
    const authority = stripScheme(origin_value) orelse return false;
    const split = splitHostPort(authority) orelse return false;
    if (!isLoopbackHost(split.host)) return false;
    return split.port == null or isPort(split.port.?);
}

fn stripScheme(value: []const u8) ?[]const u8 {
    inline for (.{ "http://", "https://" }) |scheme| {
        if (std.mem.startsWith(u8, value, scheme)) return value[scheme.len..];
    }
    return null;
}

const HostPort = struct { host: []const u8, port: ?[]const u8 };

/// Split `host[:port]`, keeping IPv6 brackets on the host. Returns null
/// for an empty host, an unterminated bracket, or a colon with nothing
/// after it.
fn splitHostPort(authority: []const u8) ?HostPort {
    if (authority.len == 0) return null;
    if (authority[0] == '[') {
        const close = std.mem.indexOfScalar(u8, authority, ']') orelse return null;
        const host = authority[0 .. close + 1];
        const rest = authority[close + 1 ..];
        if (rest.len == 0) return .{ .host = host, .port = null };
        if (rest[0] != ':' or rest.len == 1) return null;
        return .{ .host = host, .port = rest[1..] };
    }
    if (std.mem.indexOfScalar(u8, authority, ':')) |colon| {
        if (colon == 0 or colon == authority.len - 1) return null;
        return .{ .host = authority[0..colon], .port = authority[colon + 1 ..] };
    }
    return .{ .host = authority, .port = null };
}

fn isLoopbackHost(host: []const u8) bool {
    return std.ascii.eqlIgnoreCase(host, "localhost") or
        std.mem.eql(u8, host, "127.0.0.1") or
        std.mem.eql(u8, host, "[::1]");
}

/// One to five digits naming a TCP port, as a serialized origin's port is.
fn isPort(port: []const u8) bool {
    if (port.len == 0 or port.len > 5) return false;
    const value = std.fmt.parseInt(u32, port, 10) catch return false;
    return value <= std.math.maxInt(u16);
}

/// A configured entry must have the shape of an origin, or the operator
/// has written something the browser will never send and the entry would
/// silently never match.
fn looksLikeOrigin(value: []const u8) bool {
    if (value.len > max_origin_bytes) return false;
    const authority = stripScheme(value) orelse return false;
    const split = splitHostPort(authority) orelse return false;
    if (split.host.len == 0) return false;
    for (split.host) |byte| {
        if (byte == '/' or byte == '?' or byte == '#' or byte == '@' or byte == ' ') return false;
    }
    return split.port == null or isPort(split.port.?);
}

test "loopback origins are allowed on any port and either scheme" {
    configure(null);
    try std.testing.expect(isAllowed("http://127.0.0.1:3000"));
    try std.testing.expect(isAllowed("http://127.0.0.1"));
    try std.testing.expect(isAllowed("https://localhost:8443"));
    try std.testing.expect(isAllowed("http://LOCALHOST:8080"));
    try std.testing.expect(isAllowed("http://[::1]:3000"));
    try std.testing.expect(isAllowed("http://[::1]"));
}

test "everything that is not loopback is refused without configuration" {
    configure(null);
    try std.testing.expect(!isAllowed("https://evil.example"));
    try std.testing.expect(!isAllowed("http://127.0.0.1.evil.example"));
    try std.testing.expect(!isAllowed("http://localhost.evil.example:3000"));
    try std.testing.expect(!isAllowed("http://127.0.0.1:3000/"));
    try std.testing.expect(!isAllowed("http://127.0.0.1:"));
    try std.testing.expect(!isAllowed("http://127.0.0.1:99999"));
    try std.testing.expect(!isAllowed("http://127.0.0.1:80a"));
    try std.testing.expect(!isAllowed("http://user@127.0.0.1"));
    try std.testing.expect(!isAllowed("http://[::1"));
    try std.testing.expect(!isAllowed("ftp://127.0.0.1"));
    try std.testing.expect(!isAllowed("127.0.0.1:3000"));
    try std.testing.expect(!isAllowed("null"));
    try std.testing.expect(!isAllowed(""));
}

test "configured origins are exact matches added to the loopback grant" {
    configure(" https://dsh.example.com , http://mymac.local:3000,, not an origin ,https://a/b");
    defer configure(null);
    try std.testing.expectEqual(2, configuredOrigins().len);
    try std.testing.expect(isAllowed("https://dsh.example.com"));
    try std.testing.expect(isAllowed("http://mymac.local:3000"));
    try std.testing.expect(isAllowed("http://127.0.0.1:3000"));
    try std.testing.expect(!isAllowed("http://dsh.example.com"));
    try std.testing.expect(!isAllowed("https://dsh.example.com:8443"));
    try std.testing.expect(!isAllowed("https://mymac.local:3000"));
    try std.testing.expect(!isAllowed("https://a/b"));
}

test "the configured list is capped and an over-long origin is refused" {
    var list: [max_configured + 2][]const u8 = undefined;
    inline for (0..max_configured + 2) |index| {
        list[index] = std.fmt.comptimePrint("https://host{d}.example", .{index});
    }
    var joined: [2048]u8 = undefined;
    var stream = std.Io.Writer.fixed(&joined);
    for (list, 0..) |entry, index| {
        if (index > 0) try stream.writeByte(',');
        try stream.writeAll(entry);
    }
    configure(stream.buffered());
    defer configure(null);
    try std.testing.expectEqual(max_configured, configuredOrigins().len);
    try std.testing.expect(isAllowed("https://host0.example"));
    try std.testing.expect(!isAllowed(std.fmt.comptimePrint("https://host{d}.example", .{max_configured})));

    const long = "https://" ++ "a" ** max_origin_bytes;
    try std.testing.expect(!isAllowed(long));
}
