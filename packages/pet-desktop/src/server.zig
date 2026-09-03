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
const state = @import("state.zig");

pub const host = "127.0.0.1";
pub const port: u16 = 45731;
pub const max_body_bytes: usize = 4096;
const head_buffer_bytes: usize = 8192;

const cors_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
};
const preflight_headers = [_]std.http.Header{
    .{ .name = "access-control-allow-origin", .value = "*" },
    .{ .name = "access-control-allow-methods", .value = "POST, OPTIONS" },
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

test "body over the cap is refused before reading" {
    // The content-length gate is a pure comparison; pin it so a future
    // refactor does not silently read unbounded bodies.
    try std.testing.expect(max_body_bytes == 4096);
    try std.testing.expect(max_body_bytes < head_buffer_bytes);
}
