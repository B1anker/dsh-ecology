//! dsh-pet-desktop state wire format: the JSON the DSH Web plugin POSTs to
//! /state, the Mood enum shared with the plugin's own `Mood` type
//! (packages/pet src/client/mood.ts — mirrored by hand; the baking
//! pipeline consumes the TS export), and the compact tab-separated line
//! the HTTP thread hands the UI loop through the external-source
//! channel. Pure std, no framework imports — everything here is
//! unit-testable without a runtime.

const std = @import("std");

/// Every expression the pet can wear. Keep in sync with
/// packages/pet/src/client/mood.ts `Mood` and with
/// packages/pet/src/desktop.ts (`MOODS`).
pub const Mood = enum {
    idle,
    thinking,
    working,
    waiting,
    sad,
    sleeping,
    celebrating,
    pet,

    pub fn fromString(text: []const u8) ?Mood {
        return std.meta.stringToEnum(Mood, text);
    }
};

/// One parsed /state body, mutable and owned by the caller's arena so
/// the server thread can sanitize the free-text fields in place before
/// encoding the channel line. All fields optional: a partial update
/// changes only what it names.
pub const StateUpdate = struct {
    mood: ?[]u8 = null,
    pet_id: ?[]u8 = null,
    name: ?[]u8 = null,
};

/// The JSON body shape as std.json decodes it (slice fields must be
/// const; StateUpdate above is the owned copy).
const StateJson = struct {
    mood: ?[]const u8 = null,
    petId: ?[]const u8 = null,
    name: ?[]const u8 = null,
};

pub const ParseError = error{ InvalidJson, UnknownMood };

/// Parse and validate one /state body into caller-arena-owned strings.
pub fn parseStateBody(allocator: std.mem.Allocator, body: []const u8) ParseError!StateUpdate {
    const parsed = std.json.parseFromSlice(
        StateJson,
        allocator,
        body,
        .{ .ignore_unknown_fields = true },
    ) catch return error.InvalidJson;
    defer parsed.deinit();
    const value = parsed.value;
    if (value.mood) |mood_text| {
        if (Mood.fromString(mood_text) == null) return error.UnknownMood;
    }
    return .{
        .mood = if (value.mood) |s| dup(allocator, s) else null,
        .pet_id = if (value.petId) |s| dup(allocator, s) else null,
        .name = if (value.name) |s| dup(allocator, s) else null,
    };
}

fn dup(allocator: std.mem.Allocator, s: []const u8) ?[]u8 {
    return allocator.dupe(u8, s) catch null;
}

/// Field separator inside the channel line: one line carries the whole
/// state (`mood\tpetId\tname`); the server thread sanitizes tabs and
/// newlines out of the free-text fields before posting.
pub const field_sep: u8 = '\t';

/// Max bytes kept per free-text field (pet id, display name) on both
/// sides of the channel.
pub const max_field_bytes: usize = 64;

/// Replace the bytes that would corrupt the channel line, in place.
pub fn sanitizeField(field: []u8) []u8 {
    for (field) |*byte| {
        if (byte.* == '\t' or byte.* == '\n' or byte.* == '\r') byte.* = ' ';
    }
    return field;
}

/// One decoded channel line, borrowing the line's storage.
pub const StateLine = struct {
    mood: ?Mood = null,
    pet_id: []const u8 = "",
    name: []const u8 = "",
};

/// Decode a `mood\tpetId\tname` channel line. An empty mood field means
/// "unchanged" (the body named no mood). Unknown mood text decodes to
/// null so one bad line never wedges the state machine — the HTTP side
/// already rejected it with a 400 anyway.
pub fn decodeStateLine(line: []const u8) StateLine {
    var it = std.mem.splitScalar(u8, line, field_sep);
    const mood_text = it.next() orelse "";
    return .{
        .mood = if (mood_text.len == 0) null else Mood.fromString(mood_text),
        .pet_id = it.next() orelse "",
        .name = it.next() orelse "",
    };
}

/// Encode one channel line into `buffer`; returns the written slice.
/// Fields longer than `max_field_bytes` are truncated.
pub fn encodeStateLine(buffer: []u8, update: StateUpdate) []const u8 {
    var stream = std.Io.Writer.fixed(buffer);
    stream.writeAll(if (update.mood) |mood| mood else "") catch unreachable;
    stream.writeByte(field_sep) catch unreachable;
    if (update.pet_id) |id| stream.writeAll(id[0..@min(id.len, max_field_bytes)]) catch unreachable;
    stream.writeByte(field_sep) catch unreachable;
    if (update.name) |name| stream.writeAll(name[0..@min(name.len, max_field_bytes)]) catch unreachable;
    return stream.buffered();
}

test "mood strings round-trip through the enum" {
    const names = [_][]const u8{ "idle", "thinking", "working", "waiting", "sad", "sleeping", "celebrating", "pet" };
    for (names) |name| {
        const mood = Mood.fromString(name) orelse return error.TestUnexpectedResult;
        try std.testing.expectEqualStrings(name, @tagName(mood));
    }
    try std.testing.expect(Mood.fromString("dancing") == null);
}

test "state body parses and validates mood" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const body = try parseStateBody(arena.allocator(), "{\"mood\":\"working\",\"petId\":\"blob\",\"name\":\"Mochi\"}");
    try std.testing.expectEqualStrings("working", body.mood.?);
    try std.testing.expectEqualStrings("blob", body.pet_id.?);
    try std.testing.expectEqualStrings("Mochi", body.name.?);

    try std.testing.expectError(error.UnknownMood, parseStateBody(arena.allocator(), "{\"mood\":\"dancing\"}"));
    try std.testing.expectError(error.InvalidJson, parseStateBody(arena.allocator(), "not json"));
    // Unknown fields are tolerated; a partial body keeps other fields unset.
    const partial = try parseStateBody(arena.allocator(), "{\"mood\":\"sad\",\"extra\":1}");
    try std.testing.expectEqualStrings("sad", partial.mood.?);
    try std.testing.expect(partial.pet_id == null);
}

test "channel line round-trips, sanitizes, and tolerates missing fields" {
    var buffer: [256]u8 = undefined;
    const line = encodeStateLine(&buffer, .{ .mood = @constCast("celebrating"), .pet_id = @constCast("blob"), .name = @constCast("Mochi") });
    const decoded = decodeStateLine(line);
    try std.testing.expectEqual(Mood.celebrating, decoded.mood.?);
    try std.testing.expectEqualStrings("blob", decoded.pet_id);
    try std.testing.expectEqualStrings("Mochi", decoded.name);

    const no_mood = decodeStateLine(encodeStateLine(&buffer, .{ .pet_id = @constCast("blob") }));
    try std.testing.expect(no_mood.mood == null);
    try std.testing.expectEqualStrings("blob", no_mood.pet_id);
    try std.testing.expectEqualStrings("", no_mood.name);

    var dirty = [_]u8{ 'a', '\t', 'b', '\n', 'c', '\r' };
    try std.testing.expectEqualStrings("a b c ", sanitizeField(&dirty));
}
