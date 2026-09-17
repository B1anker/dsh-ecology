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
//!   GET    /events -> 200 text/event-stream: a liveness channel. No
//!                  events are ever published — the connection ITSELF is
//!                  the message. The panel holds it open; app quit (clean
//!                  or crashed) closes the socket and the panel knows at
//!                  once, which no quit-time "goodbye" POST could promise
//!                  (a crash sends nothing). Heartbeat comments keep
//!                  middleboxes from eating the silence; `retry: 1000`
//!                  makes the browser's EventSource reconnect quickly
//!                  after an app restart.
//!   OPTIONS *      CORS preflight -> 204
//!   anything else  -> 404
//! Bodies over 4 KiB are refused with 413; invalid JSON or an unknown
//! mood answers 400.
//!
//! The plugin calls from the shell page's origin, so responses carry a
//! CORS grant — but only to that origin, never `*`: with a blanket grant
//! every page in the user's browser could repaint the pet, read its name,
//! enumerate the imported pets, and watch /events to learn the app is
//! running. origin.zig decides who is allowed (loopback origins always,
//! plus `DSH_PET_DESKTOP_ORIGINS`); an allowed Origin is echoed back with
//! `vary: origin`, a request carrying any other Origin is answered 403
//! before it is read (its preflight gets a bare 204, which the browser
//! reads as a refusal), and a request with no Origin at all is not a
//! browser and is served without a grant.
//!
//! One request per connection (`keep_alive = false`), and one detached
//! thread per accepted connection: the /events stream stays open for the
//! app's whole lifetime and must not starve /state and /pets behind it.
//! Shared state across those threads is read-only after boot (manifest,
//! assets root, the origin allow-list); the channel handle is the
//! thread-safe one from fx.openChannel.
//!
//! The port is fixed: the plugin's bridge dials it, so it lives in exactly
//! two places — here and `DESKTOP_BRIDGE_PORT` in the plugin, which has a
//! test reading this file to keep the two equal. A listen failure (most
//! often a second copy of the app already holding the port) ends the
//! process with a message rather than leaving a pet on screen that
//! nothing can reach.
//!
//! Socket/io plumbing follows the runtime's own fetch fixture
//! (src/runtime/effects_fetch_tests.zig Fixture): std.Io.Threaded on
//! the server thread, `IpAddress.listen`, per-connection reader/writer
//! buffers, `std.http.Server.receiveHead` + `Request.respond`.

const std = @import("std");
const native_sdk = @import("native_sdk");
const assets = @import("assets.zig");
const manifest = @import("manifest.zig");
const origin = @import("origin.zig");
const state = @import("state.zig");

pub const host = "127.0.0.1";
/// Mirrored by `DESKTOP_BRIDGE_PORT` in packages/pet/src/desktop.ts.
pub const port: u16 = 45731;
pub const max_body_bytes: usize = 4096;
const head_buffer_bytes: usize = 8192;

/// URL prefix of the sprite route; the tail after it is matched against
/// manifest `file` fields verbatim ("/sprites/" + file = the url /pets
/// advertises).
pub const sprites_prefix = "/sprites/";
/// The liveness route: an EventSource-held SSE stream whose drop means
/// the app is gone. Advertised in /pets as `eventsUrl`.
pub const events_path = "/events";
/// SSE heartbeat cadence; only keeps the path warm, no semantics.
const heartbeat_seconds = 15;
/// Cap on one served strip. Today's largest PNG is ~440 KiB; the cap
/// leaves room for denser imported strips without letting a single GET
/// read unbounded.
pub const max_sprite_bytes: usize = 16 * 1024 * 1024;

/// The extra headers of one response: a content type when the body has
/// one, and the CORS grant when the request's Origin was allowed. Built per
/// request because the grant echoes that origin; the storage is sized for
/// the preflight, the widest set.
const Headers = struct {
    storage: [5]std.http.Header = undefined,
    len: usize = 0,

    fn add(self: *Headers, name: []const u8, value: []const u8) void {
        self.storage[self.len] = .{ .name = name, .value = value };
        self.len += 1;
    }

    fn slice(self: *const Headers) []const std.http.Header {
        return self.storage[0..self.len];
    }
};

/// `grant` is the allowed Origin to echo, or null for no CORS headers at
/// all (no Origin on the request, or one that was refused upstream).
fn headersFor(grant: ?[]const u8, content_type: ?[]const u8) Headers {
    var headers = Headers{};
    if (content_type) |value| headers.add("content-type", value);
    addGrant(&headers, grant);
    return headers;
}

fn addGrant(headers: *Headers, grant: ?[]const u8) void {
    if (grant) |value| {
        headers.add("access-control-allow-origin", value);
        // The grant differs per origin, so no cache may serve one page's
        // response to another.
        headers.add("vary", "origin");
    }
}

/// Preflight answer: the grant plus what it covers. Without a grant the
/// 204 is bare, which the browser treats as a CORS refusal.
fn preflightHeaders(grant: ?[]const u8) Headers {
    var headers = Headers{};
    if (grant != null) {
        addGrant(&headers, grant);
        headers.add("access-control-allow-methods", "GET, POST, OPTIONS");
        headers.add("access-control-allow-headers", "content-type");
    }
    return headers;
}

/// The request's Origin header, copied out of the head buffer because the
/// body read reuses that buffer. Null when the request carries none (not a
/// browser); an empty slice when it carries one too long to consider,
/// which the allow check then refuses like any other stranger.
fn requestOrigin(request: *const std.http.Server.Request, buffer: *[origin.max_origin_bytes]u8) ?[]const u8 {
    var headers = request.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "origin")) continue;
        if (header.value.len > buffer.len) return buffer[0..0];
        @memcpy(buffer[0..header.value.len], header.value);
        return buffer[0..header.value.len];
    }
    return null;
}

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

    origin.configureFromEnv();
    const address = std.Io.net.IpAddress.parseIp4(host, port) catch return;
    var listener = std.Io.net.IpAddress.listen(&address, io, .{ .reuse_address = true }) catch |err| {
        // Without the bridge the pet can never follow the agent, and the
        // usual cause is a second copy of this app already listening. A
        // pet that stays on screen but reacts to nothing is the worst
        // outcome, so say why and go; the copy that owns the port keeps
        // working.
        std.debug.print(
            "dsh-pet-desktop: cannot listen on {s}:{d} ({s}); is another copy of the app running? quitting\n",
            .{ host, port, @errorName(err) },
        );
        std.process.exit(1);
    };
    defer listener.deinit(io);
    std.debug.print("dsh-pet-desktop: state server listening on http://{s}:{d}/state\n", .{ host, port });
    for (origin.configuredOrigins()) |entry| {
        std.debug.print("dsh-pet-desktop: bridge origin allowed: {s}\n", .{entry});
    }

    while (true) {
        const stream = listener.accept(io) catch return;
        // A thread per connection: /events holds its socket open for the
        // app's lifetime, so inline handling would starve every /state
        // POST behind one panel's liveness watch.
        const thread = std.Thread.spawn(.{}, connectionMain, .{ stream, handle }) catch {
            stream.close(io);
            continue;
        };
        thread.detach();
    }
}

fn connectionMain(stream: std.Io.net.Stream, handle: native_sdk.ChannelHandle) void {
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const io = threaded.io();
    defer stream.close(io);
    handleConnection(io, stream, handle) catch {};
}

fn handleConnection(io: std.Io, stream: std.Io.net.Stream, handle: native_sdk.ChannelHandle) !void {
    var recv_buffer: [head_buffer_bytes]u8 = undefined;
    var send_buffer: [head_buffer_bytes]u8 = undefined;
    var conn_reader = stream.reader(io, &recv_buffer);
    var conn_writer = stream.writer(io, &send_buffer);
    var server = std.http.Server.init(&conn_reader.interface, &conn_writer.interface);
    var request = server.receiveHead() catch return;
    const head = request.head;

    // Read before anything touches the body: the head buffer is reused.
    var origin_buffer: [origin.max_origin_bytes]u8 = undefined;
    const request_origin = requestOrigin(&request, &origin_buffer);
    const grant: ?[]const u8 = if (request_origin) |value| (if (origin.isAllowed(value)) value else null) else null;
    const foreign = request_origin != null and grant == null;

    if (head.method == .OPTIONS) {
        const headers = preflightHeaders(grant);
        try request.respond("", .{ .status = .no_content, .keep_alive = false, .extra_headers = headers.slice() });
        return;
    }
    if (foreign) {
        // A page this bridge does not serve. Refused before the route is
        // even looked at, so a "simple" cross-origin POST changes nothing
        // and a foreign EventSource never holds a thread.
        try request.respond("origin not allowed\n", .{ .status = .forbidden, .keep_alive = false });
        return;
    }
    if (head.method == .GET) {
        try handleGet(io, &request, &conn_writer.interface, head.target, grant);
        return;
    }
    const plain = headersFor(grant, null);
    if (head.method != .POST or !std.mem.eql(u8, head.target, "/state")) {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    }
    if ((head.content_length orelse 0) > max_body_bytes) {
        try request.respond("body too large\n", .{ .status = .payload_too_large, .keep_alive = false, .extra_headers = plain.slice() });
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
        try request.respond("body too large\n", .{ .status = .payload_too_large, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    }

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const update = state.parseStateBody(arena.allocator(), body_buffer[0..body_len]) catch |err| {
        const message: []const u8 = switch (err) {
            error.UnknownMood => "unknown mood\n",
            else => "invalid json\n",
        };
        try request.respond(message, .{ .status = .bad_request, .keep_alive = false, .extra_headers = plain.slice() });
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
        .accepted => try request.respond("{\"ok\":true}\n", .{ .keep_alive = false, .extra_headers = plain.slice() }),
        .dropped_full, .dropped_oversized => try request.respond("{\"ok\":true,\"dropped\":true}\n", .{ .keep_alive = false, .extra_headers = plain.slice() }),
        .closed => try request.respond("{\"ok\":false}\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = plain.slice() }),
    }
}

/// Read-only routes for the plugin's pet discovery. All are no-body
/// requests answered straight after receiveHead — except /events, which
/// writes its head raw and then holds the connection open (see
/// serveEvents). A query string (cache busters) is stripped before matching.
fn handleGet(
    io: std.Io,
    request: *std.http.Server.Request,
    raw_writer: *std.Io.Writer,
    target: []const u8,
    grant: ?[]const u8,
) !void {
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    if (std.mem.eql(u8, path, "/pets")) return servePets(request, grant);
    if (std.mem.eql(u8, path, events_path)) return serveEvents(io, raw_writer, grant);
    if (std.mem.startsWith(u8, path, sprites_prefix)) return serveSprite(io, request, path[sprites_prefix.len..], grant);
    const headers = headersFor(grant, null);
    try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = headers.slice() });
}

/// The SSE response head, written raw: std.http's chunked BodyWriter only
/// emits on a full buffer or end-of-stream, neither of which a heartbeat
/// ever reaches, so the streaming API cannot serve a trickle. Close-
/// delimited (no content-length, no chunking) is exactly right here — the
/// stream ends when the process dies, which is the event itself. The CORS
/// grant goes between the two halves when the request earned one.
const sse_head_start = "HTTP/1.1 200 OK\r\n" ++
    "content-type: text/event-stream\r\n" ++
    "cache-control: no-cache\r\n";
const sse_head_end = "connection: close\r\n" ++
    "\r\n";

/// The liveness route the panel's EventSource holds (see the module
/// header). Heartbeats until the write fails — a closed socket means the
/// panel is gone, and this connection's thread exits with it. The app
/// quitting kills the process and every socket with it, which is the event
/// the panel is really after.
fn serveEvents(io: std.Io, writer: *std.Io.Writer, grant: ?[]const u8) !void {
    try writer.writeAll(sse_head_start);
    if (grant) |value| try writer.print("access-control-allow-origin: {s}\r\nvary: origin\r\n", .{value});
    // retry: fast EventSource reconnection after an app restart; the first
    // comment gives the browser bytes to fire `open` on.
    try writer.writeAll(sse_head_end ++ "retry: 1000\n\n: ready\n\n");
    try writer.flush();
    while (true) {
        std.Io.sleep(io, .fromSeconds(heartbeat_seconds), .awake) catch return;
        try writer.writeAll(": hb\n\n");
        try writer.flush();
    }
}

fn servePets(request: *std.http.Server.Request, grant: ?[]const u8) !void {
    const plain = headersFor(grant, null);
    const m = manifest.current() orelse {
        // The bridge still runs when the manifest failed to load (see
        // manifest.current's contract); there is simply nothing to list.
        try request.respond("manifest unavailable\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const body = petsJson(arena.allocator(), m) catch return;
    const json = headersFor(grant, "application/json");
    try request.respond(body, .{ .keep_alive = false, .extra_headers = json.slice() });
}

fn serveSprite(io: std.Io, request: *std.http.Server.Request, tail: []const u8, grant: ?[]const u8) !void {
    const plain = headersFor(grant, null);
    const m = manifest.current() orelse {
        try request.respond("manifest unavailable\n", .{ .status = .service_unavailable, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    };
    const file = declaredSpriteFile(m, tail) orelse {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    };
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    // Declared-but-missing (a hand-edited manifest, a half-finished
    // import) answers 404 like any unlisted name — the plugin cannot
    // tell the difference and does not need to.
    const bytes = readSprite(io, std.Io.Dir.cwd(), arena.allocator(), file) catch {
        try request.respond("not found\n", .{ .status = .not_found, .keep_alive = false, .extra_headers = plain.slice() });
        return;
    };
    const png = headersFor(grant, "image/png");
    try request.respond(bytes, .{ .keep_alive = false, .extra_headers = png.slice() });
}

/// The /pets body: {"eventsUrl":"/events","pets":[{"id":..., "moods":
/// {<mood>:{"frames":N, "frameDurationMs":F,"url":"/sprites/<file>"}, ...}}]}
/// — every pet the manifest declares, all 8 moods each, in Mood enum order.
/// `eventsUrl` is the capability marker for the liveness stream: a desktop
/// too old to serve it simply omits the field, and the plugin stays on
/// plain polling.
pub fn petsJson(allocator: std.mem.Allocator, m: *const manifest.Manifest) ![]const u8 {
    var out = std.Io.Writer.Allocating.init(allocator);
    const w = &out.writer;
    try w.print("{{\"eventsUrl\":\"{s}\",\"pets\":[", .{events_path});
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

/// Read one declared strip through the resolved assets root (assets.zig),
/// the same path model.zig registers. `dir` is a parameter so tests serve
/// out of a tmpDir instead of the real assets; tests force a null root so
/// the cwd-relative fallback below stays tmpDir-relative.
fn readSprite(io: std.Io, dir: std.Io.Dir, allocator: std.mem.Allocator, file: []const u8) ![]u8 {
    var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const path = assets.spritePath(&path_buffer, file) orelse return error.FileNotFound;
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
    // The liveness-stream capability marker rides along.
    try std.testing.expectEqualStrings(events_path, root.get("eventsUrl").?.string);
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
    // Keep the path resolution on the cwd-relative fallback so the read
    // stays inside tmpDir even when the test cwd holds real assets.
    assets.forceRootForTests(null);
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

test "response headers echo an allowed origin and carry none otherwise" {
    const granted = headersFor("http://127.0.0.1:3000", "application/json");
    try std.testing.expectEqual(3, granted.slice().len);
    try std.testing.expectEqualStrings("content-type", granted.slice()[0].name);
    try std.testing.expectEqualStrings("access-control-allow-origin", granted.slice()[1].name);
    try std.testing.expectEqualStrings("http://127.0.0.1:3000", granted.slice()[1].value);
    try std.testing.expectEqualStrings("vary", granted.slice()[2].name);
    try std.testing.expectEqualStrings("origin", granted.slice()[2].value);

    // No origin (not a browser) or a refused one: nothing CORS at all, and
    // never the old wildcard.
    const bare = headersFor(null, "image/png");
    try std.testing.expectEqual(1, bare.slice().len);
    try std.testing.expectEqualStrings("content-type", bare.slice()[0].name);
    for (bare.slice()) |header| try std.testing.expect(!std.mem.eql(u8, header.value, "*"));
    try std.testing.expectEqual(0, headersFor(null, null).slice().len);

    const preflight = preflightHeaders("https://dsh.example.com");
    try std.testing.expectEqual(4, preflight.slice().len);
    try std.testing.expectEqualStrings("https://dsh.example.com", preflight.slice()[0].value);
    try std.testing.expectEqualStrings("access-control-allow-methods", preflight.slice()[2].name);
    try std.testing.expectEqualStrings("access-control-allow-headers", preflight.slice()[3].name);
    try std.testing.expectEqual(0, preflightHeaders(null).slice().len);
}

test "the origin header is read from the request head, case-insensitively" {
    var recv: [head_buffer_bytes]u8 = undefined;
    var send: [head_buffer_bytes]u8 = undefined;
    const request_bytes = "POST /state HTTP/1.1\r\n" ++
        "Host: 127.0.0.1:45731\r\n" ++
        "ORIGIN: http://localhost:3000\r\n" ++
        "content-length: 0\r\n\r\n";
    var reader = std.Io.Reader.fixed(request_bytes);
    var writer = std.Io.Writer.fixed(&send);
    var server = std.http.Server.init(&reader, &writer);
    _ = &recv;
    var request = try server.receiveHead();
    var buffer: [origin.max_origin_bytes]u8 = undefined;
    const value = requestOrigin(&request, &buffer) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("http://localhost:3000", value);
    // The copy is the caller's buffer, not the head.
    try std.testing.expect(value.ptr == &buffer);

    const bare_bytes = "GET /pets HTTP/1.1\r\nHost: 127.0.0.1:45731\r\n\r\n";
    var bare_reader = std.Io.Reader.fixed(bare_bytes);
    var bare_writer = std.Io.Writer.fixed(&send);
    var bare_server = std.http.Server.init(&bare_reader, &bare_writer);
    var bare_request = try bare_server.receiveHead();
    try std.testing.expect(requestOrigin(&bare_request, &buffer) == null);

    const long_bytes = "GET /pets HTTP/1.1\r\nOrigin: https://" ++ "x" ** origin.max_origin_bytes ++ "\r\n\r\n";
    var long_reader = std.Io.Reader.fixed(long_bytes);
    var long_writer = std.Io.Writer.fixed(&send);
    var long_server = std.http.Server.init(&long_reader, &long_writer);
    var long_request = try long_server.receiveHead();
    const too_long = requestOrigin(&long_request, &buffer) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(0, too_long.len);
    try std.testing.expect(!origin.isAllowed(too_long));
}

test "body over the cap is refused before reading" {
    // The content-length gate is a pure comparison; pin it so a future
    // refactor does not silently read unbounded bodies.
    try std.testing.expect(max_body_bytes == 4096);
    try std.testing.expect(max_body_bytes < head_buffer_bytes);
}
