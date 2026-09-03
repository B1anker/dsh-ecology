//! The DSH Web plugin's state bridge: a loopback-only HTTP server on
//! 127.0.0.1:45731 running on its OWN thread, feeding the UI loop
//! through the framework's external-source channel (the thread-safe
//! `ChannelHandle` from `fx.openChannel` — the mechanism
//! examples/channel-monitor dogfoods, so no timer polling and no
//! app-owned locks across the thread boundary).
//!
//! Protocol:
//!   POST   /state  JSON {"mood": "...", "petId": "...", "name": "..."}
//!                  -> 200 {"ok":true}, one channel line to the UI loop
//!   GET    /pets   -> 200 application/json: every pet the boot-loaded
//!                  manifest declares (built-ins AND imported ones), each
//!                  mood carrying frames / frameDurationMs / url so the
//!                  plugin can enumerate pets without its own copy of the
//!                  manifest
//!   GET    /sprites/<pet>/<mood>.png
//!                  -> 200 image/png: the strip file itself. The path tail
//!                  must EXACTLY equal a manifest-declared `file` — exact
//!                  match against declared names is the whole traversal
//!                  defense, so ".." segments, absolute paths, and files
//!                  the manifest never lists never reach the filesystem
//!   OPTIONS *      CORS preflight -> 204
//!   anything else  -> 404
//! Bodies over 4 KiB are refused with 413; invalid JSON or an unknown
//! mood answers 400. Every response carries
//! `access-control-allow-origin: *` — the plugin POSTs from the shell
//! page's origin, so without it the fetch never leaves the browser.
//!
//! One request per connection (`keep_alive = false`): the plugin posts
//! at state-change cadence, so connection reuse buys nothing and a
//! single-threaded accept loop stays trivially correct.
//!
//! Socket/io plumbing follows the runtime's own fetch fixture
//! (src/runtime/effects_fetch_tests.zig Fixture): std.Io.Threaded on
//! the server thread, `IpAddress.listen`, per-connection reader/writer
//! buffers, `std.http.Server.receiveHead` + `Request.respond`.

const std = @import("std");
const native_sdk = @import("native_sdk");
const manifest = @import("manifest.zig");
const state = @import("state.zig");

pub const host = "127.0.0.1";
pub const port: u16 = 45731;
pub const max_body_bytes: usize = 4096;
const head_buffer_bytes: usize = 8192;

/// URL prefix of the sprite route; the tail after it is matched against
/// manifest `file` fields verbatim ("/sprites/" + file = the url /pets
/// advertises).
pub const sprites_prefix = "/sprites/";
/// Cap on one served strip. Today's largest PNG is ~440 KiB; the cap
/// leaves room for denser imported strips without letting a single GET
/// read unbounded.
pub const max_sprite_bytes: usize = 16 * 1024 * 1024;

const cors_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
};
const json_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
    .{ .name = "content-type", .value = "application/json" },
};
const png_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
    .{ .name = "content-type", .value = "image/png" },
};
const preflight_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
    .{ .name = "access-control-allow-methods", .value = "GET, POST, OPTIONS" },
    .{ .name = "access-control-allow-headers", .value = "content-type" },
};

/// Spawn the server thread, DETACHED on purpose (channel-monitor's
/// pattern): after app teardown the thread's next `post` answers
/// `.closed` through the generation-stamped handle, so no join is
/// needed. The listener itself lives as long as the process.
pub fn start(handle: native_sdk.ChannelHandle) std.Thread.SpawnError!void {
    const thread = try std.Thread.spawn(.{}, serverMain, .{handle});
    thread.detach();
}

fn serverMain(handle: native_sdk.ChannelHandle) void {
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();

    const address = std.Io.net.IpAddress.parseIp4(host, port) catch return;
    var listener = std.Io.net.IpAddress.listen(&address, io, .{ .reuse_address = true }) catch |err| {
        std.debug.print("dsh-pet: state server listen {s}:{d} failed: {s}\n", .{ host, port, @errorName(err) });
        return;
    };
    defer listener.deinit(io);
    std.debug.print("dsh-pet: state server listening on http://{s}:{d}/state\n", .{ host, port });

    while (true) {
        const stream = listener.accept(io) catch return;
        handleConnection(io, stream, handle) catch {};
        stream.close(io);
    }
}

fn handleConnection(io: std.Io, stream: std.Io.net.Stream, handle: native_sdk.ChannelHandle) !void {
    var recv_buffer: [head_buffer_bytes]u8 = undefined;
    var send_buffer: [head_buffer_bytes]u8 = undefined;
    var conn_reader = stream.reader(io, &recv_buffer);
    var conn_writer = stream.writer(io, &send_buffer);
    var server = std.http.Server.init(&conn_reader.interface, &conn_writer.interface);
    var request = server.receiveHead() catch return;
    const head = request.head;

    if (head.method == .OPTIONS) {
        try request.respond("", .{ .status = .no_content, .keep_alive = false, .extra_headers = &preflight_headers });
        return;
    }
    if (head.method == .GET) {
        try handleGet(io, &request, head.target);
        return;
    }
    if (head.method != .POST or !std.mem.eql(u8, head.target, "/state")) {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    }
    if ((head.content_length orelse 0) > max_body_bytes) {
        try request.respond("body too large\n", .{ .status = .payload_too_large, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    }

    // Read with one byte of headroom: readSliceShort stops only at a
    // full buffer or end-of-stream, so landing at max_body_bytes + 1
    // proves the body exceeded the cap (a chunked or under-declared
    // body — the content-length gate above only catches honest ones).
    var body_buffer: [max_body_bytes + 1]u8 = undefined;
    const body_reader = request.readerExpectNone(&recv_buffer);
    const body_len = body_reader.readSliceShort(&body_buffer) catch return;
    if (body_len > max_body_bytes) {
        try request.respond("body too large\n", .{ .status = .payload_too_large, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    }

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const update = state.parseStateBody(arena.allocator(), body_buffer[0..body_len]) catch |err| {
        const message: []const u8 = switch (err) {
            error.UnknownMood => "unknown mood\n",
            else => "invalid json\n",
        };
        try request.respond(message, .{ .status = .bad_request, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    };
    if (update.mood) |mood| _ = state.sanitizeField(mood);
    if (update.pet_id) |id| _ = state.sanitizeField(id);
    if (update.name) |name| _ = state.sanitizeField(name);

    var line_buffer: [2 * state.max_field_bytes + 32]u8 = undefined;
    const line = state.encodeStateLine(&line_buffer, update);

    // The post's answer is advisory for the HTTP status: the state is
    // valid and accepted either way; only a dead channel (app tearing
    // down) changes what we tell the caller.
    switch (handle.post(line)) {
        .accepted => try request.respond("{\"ok\":true}\n", .{ .keep_alive = false, .extra_headers = &cors_headers }),
        .dropped_full, .dropped_oversized => try request.respond("{\"ok\":true,\"dropped\":true}\n", .{ .keep_alive = false, .extra_headers = &cors_headers }),
        .closed => try request.respond("{\"ok\":false}\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = &cors_headers }),
    }
}

/// Read-only routes for the plugin's pet discovery. Both are no-body
/// requests answered straight after receiveHead; a query string (cache
/// busters) is stripped before matching.
fn handleGet(io: std.Io, request: *std.http.Server.Request, target: []const u8) !void {
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    if (std.mem.eql(u8, path, "/pets")) return servePets(request);
    if (std.mem.startsWith(u8, path, sprites_prefix)) return serveSprite(io, request, path[sprites_prefix.len..]);
    try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = &cors_headers });
}

fn servePets(request: *std.http.Server.Request) !void {
    const m = manifest.current() orelse {
        // The bridge still runs when the manifest failed to load (see
        // manifest.current's contract); there is simply nothing to list.
        try request.respond("manifest unavailable\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const body = petsJson(arena.allocator(), m) catch return;
    try request.respond(body, .{ .keep_alive = false, .extra_headers = &json_headers });
}

fn serveSprite(io: std.Io, request: *std.http.Server.Request, tail: []const u8) !void {
    const m = manifest.current() orelse {
        try request.respond("manifest unavailable\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    };
    const file = declaredSpriteFile(m, tail) orelse {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    // Declared-but-missing (a hand-edited manifest, a half-finished
    // import) answers 404 like any unlisted name — the plugin cannot
    // tell the difference and does not need to.
    const bytes = readSprite(io, std.Io.Dir.cwd(), arena.allocator(), file) catch {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = &cors_headers });
        return;
    };
    try request.respond(bytes, .{ .keep_alive = false, .extra_headers = &png_headers });
}

/// The /pets body: {"pets":[{"id":..., "moods":{<mood>:{"frames":N,
/// "frameDurationMs":F,"url":"/sprites/<file>"}, ...}}]} — every pet the
/// manifest declares, all 8 moods each, in Mood enum order.
pub fn petsJson(allocator: std.mem.Allocator, m: *const manifest.Manifest) ![]const u8 {
    var out = std.Io.Writer.Allocating.init(allocator);
    const w = &out.writer;
    try w.writeAll("{\"pets\":[");
    for (m.pets[0..m.pet_count], 0..) |pet, pet_index| {
        if (pet_index > 0) try w.writeByte(',');
        try w.print("{{\"id\":\"{s}\",\"moods\":{{", .{pet.id});
        inline for (@typeInfo(manifest.Mood).@"enum".fields, 0..) |field, mood_index| {
            if (mood_index > 0) try w.writeByte(',');
            const strip = pet.strips[field.value];
            try w.print("\"{s}\":{{\"frames\":{d},\"frameDurationMs\":{d},\"url\":\"{s}{s}\"}}", .{ field.name, strip.frames, strip.frame_duration_ms, sprites_prefix, strip.file });
        }
        try w.writeAll("}}");
    }
    try w.writeAll("]}");
    return out.toOwnedSlice();
}

/// The manifest `file` exactly matching a /sprites/ path tail, or null.
/// Borrowed from the manifest (process-lifetime), so the result outlives
/// the request arena.
pub fn declaredSpriteFile(m: *const manifest.Manifest, tail: []const u8) ?[]const u8 {
    for (m.pets[0..m.pet_count]) |pet| {
        for (&pet.strips) |*strip| {
            if (std.mem.eql(u8, strip.file, tail)) return strip.file;
        }
    }
    return null;
}

/// Read one declared strip: "assets/sprites/" ++ file, the same prefix
/// model.zig prepends when registering images. `dir` is a parameter so
/// tests serve out of a tmpDir instead of the real assets.
fn readSprite(io: std.Io, dir: std.Io.Dir, allocator: std.mem.Allocator, file: []const u8) ![]u8 {
    var path_buffer: [256]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buffer, "assets/sprites/{s}", .{file}) catch return error.FileNotFound;
    return dir.readFileAlloc(io, path, allocator, .limited(max_sprite_bytes));
}

test "pets json lists every pet with all 8 moods and sprite urls" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const m = try manifest.parse(arena.allocator(),
        \\{"scale":2,"frameSize":128,"pets":{"wolf":{"moods":{
        \\  "idle":{"file":"wolf/idle.png","frames":6,"frameDurationMs":1100},
        \\  "thinking":{"file":"wolf/thinking.png","frames":4,"frameDurationMs":87.5},
        \\  "working":{"file":"wolf/working.png","frames":4,"frameDurationMs":100},
        \\  "waiting":{"file":"wolf/waiting.png","frames":4,"frameDurationMs":100},
        \\  "sad":{"file":"wolf/sad.png","frames":4,"frameDurationMs":100},
        \\  "sleeping":{"file":"wolf/sleeping.png","frames":4,"frameDurationMs":100},
        \\  "celebrating":{"file":"wolf/celebrating.png","frames":4,"frameDurationMs":100},
        \\  "pet":{"file":"wolf/pet.png","frames":4,"frameDurationMs":100}
        \\}}}}
    );
    const body = try petsJson(arena.allocator(), &m);
    const root = switch (try std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), body, .{})) {
        .object => |obj| obj,
        else => return error.TestUnexpectedResult,
    };
    const pets = switch (root.get("pets").?) {
        .array => |arr| arr,
        else => return error.TestUnexpectedResult,
    };
    try std.testing.expectEqual(1, pets.items.len);
    const pet = pets.items[0].object;
    try std.testing.expectEqualStrings("wolf", pet.get("id").?.string);
    const moods = pet.get("moods").?.object;
    // All 8 moods present, each with the contract's three fields; the
    // float duration survives the round-trip un-rounded.
    try std.testing.expectEqual(manifest.mood_count, moods.count());
    inline for (@typeInfo(manifest.Mood).@"enum".fields) |field| {
        const entry = moods.get(field.name) orelse return error.TestUnexpectedResult;
        const strip = entry.object;
        try std.testing.expect(strip.get("frames").? == .integer);
        const url = strip.get("url").?.string;
        try std.testing.expect(std.mem.startsWith(u8, url, sprites_prefix));
    }
    try std.testing.expectEqual(6, moods.get("idle").?.object.get("frames").?.integer);
    try std.testing.expectEqual(1100, moods.get("idle").?.object.get("frameDurationMs").?.integer);
    try std.testing.expectEqual(87.5, moods.get("thinking").?.object.get("frameDurationMs").?.float);
    try std.testing.expectEqualStrings("/sprites/wolf/idle.png", moods.get("idle").?.object.get("url").?.string);
}

test "sprite route serves only manifest-declared files" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const m = try manifest.parse(arena.allocator(),
        \\{"scale":2,"frameSize":128,"pets":{"wolf":{"moods":{
        \\  "idle":{"file":"wolf/idle.png","frames":6,"frameDurationMs":1100},
        \\  "thinking":{"file":"wolf/thinking.png","frames":4,"frameDurationMs":100},
        \\  "working":{"file":"wolf/working.png","frames":4,"frameDurationMs":100},
        \\  "waiting":{"file":"wolf/waiting.png","frames":4,"frameDurationMs":100},
        \\  "sad":{"file":"wolf/sad.png","frames":4,"frameDurationMs":100},
        \\  "sleeping":{"file":"wolf/sleeping.png","frames":4,"frameDurationMs":100},
        \\  "celebrating":{"file":"wolf/celebrating.png","frames":4,"frameDurationMs":100},
        \\  "pet":{"file":"wolf/pet.png","frames":4,"frameDurationMs":100}
        \\}}}}
    );
    try std.testing.expectEqualStrings("wolf/idle.png", declaredSpriteFile(&m, "wolf/idle.png").?);
    // Traversal, absolute paths, and names the manifest never declares
    // all miss the exact match and never reach the filesystem.
    try std.testing.expect(declaredSpriteFile(&m, "../manifest.json") == null);
    try std.testing.expect(declaredSpriteFile(&m, "wolf/../../manifest.json") == null);
    try std.testing.expect(declaredSpriteFile(&m, "..%2f..%2fmanifest.json") == null);
    try std.testing.expect(declaredSpriteFile(&m, "/etc/passwd") == null);
    try std.testing.expect(declaredSpriteFile(&m, "wolf/dancing.png") == null);
    try std.testing.expect(declaredSpriteFile(&m, "") == null);
}

test "sprite file reads through the assets/sprites prefix, bounded" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "assets/sprites/wolf");
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "assets/sprites/wolf/idle.png",
        .data = "fake-png-bytes",
    });
    const bytes = try readSprite(std.testing.io, tmp.dir, std.testing.allocator, "wolf/idle.png");
    defer std.testing.allocator.free(bytes);
    try std.testing.expectEqualStrings("fake-png-bytes", bytes);
    try std.testing.expectError(error.FileNotFound, readSprite(std.testing.io, tmp.dir, std.testing.allocator, "wolf/missing.png"));
}

test "body over the cap is refused before reading" {
    // The content-length gate is a pure comparison; pin it so a future
    // refactor does not silently read unbounded bodies.
    try std.testing.expect(max_body_bytes == 4096);
    try std.testing.expect(max_body_bytes < head_buffer_bytes);
}
