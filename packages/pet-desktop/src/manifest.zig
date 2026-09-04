//! Sprite manifest: runtime-parsed `assets/sprites/manifest.json`, the
//! SINGLE SOURCE for strip geometry (file, frame count, frame duration)
//! per (pet, mood). Nothing about the animation is hardcoded — the
//! baking pipeline (packages/pet-desktop/scripts/bake-sprites.mjs)
//! writes this file, and the Zig side derives ids, cadences, and crop
//! rects from it. The Mood enum itself stays hand-mirrored in
//! src/state.zig because /state validation needs it.
//!
//! Contract (written by the baker):
//!   { "scale": 2, "frameSize": 128,
//!     "pets": { "<petId>": { "moods": { "<mood>":
//!       { "file": "<petId>/<mood>.png", "frames": N, "frameDurationMs": F } } } } }
//! Each strip is N horizontal frames of frameSize×frameSize CSS points
//! at scale× physical pixels (256×256 at scale 2), RGBA, loop-seamless.
//!
//! Image-id mapping: `image_id_base + pet_index * image_id_stride +
//! @intFromEnum(mood)` — stable across runs, decodable from the
//! `image_done` result's echoed id, and clear of the timer/channel key
//! space (1..5) by construction.

const std = @import("std");
const state = @import("state.zig");

pub const Mood = state.Mood;
pub const mood_count = @typeInfo(Mood).@"enum".fields.len;

/// Capacity for the manifest's pet table. blob/cat/robot ship
/// today; the rest is headroom for imported pets (see scripts/import-codex-pet.mjs).
pub const max_pets = 8;

pub const image_id_base: u64 = 100;
pub const image_id_stride: u64 = 16;

/// One mood's strip as the manifest declares it.
pub const StripEntry = struct {
    /// Manifest-relative file ("blob/idle.png"); the app prepends
    /// "assets/sprites/" when issuing the load.
    file: []const u8 = "",
    frames: u32 = 0,
    frame_duration_ms: f64 = 0,
};

pub const PetEntry = struct {
    id: []const u8 = "",
    /// Indexed by @intFromEnum(mood); every one of the 8 moods is
    /// required — a pet with a partial set fails the whole parse,
    /// because /state can legitimately name any mood at any time.
    strips: [mood_count]StripEntry = [_]StripEntry{.{}} ** mood_count,
};

pub const Manifest = struct {
    scale: u32 = 0,
    frame_size: u32 = 0,
    pets: [max_pets]PetEntry = [_]PetEntry{.{}} ** max_pets,
    pet_count: usize = 0,

    pub fn petIndex(self: *const Manifest, pet_id: []const u8) ?usize {
        for (self.pets[0..self.pet_count], 0..) |pet, index| {
            if (std.mem.eql(u8, pet.id, pet_id)) return index;
        }
        return null;
    }

    pub fn strip(self: *const Manifest, pet_index: usize, mood: Mood) StripEntry {
        return self.pets[pet_index].strips[@intFromEnum(mood)];
    }
};

pub const ParseError = error{ InvalidJson, InvalidManifest, TooManyPets };

/// Parse one manifest document. Strings borrow the parsed JSON tree, so
/// the tree is LEAKED into `allocator` on purpose — pass an arena whose
/// lifetime covers the returned Manifest (the app parses once at boot
/// into a process-lifetime arena).
pub fn parse(allocator: std.mem.Allocator, source: []const u8) ParseError!Manifest {
    const root = switch (std.json.parseFromSliceLeaky(std.json.Value, allocator, source, .{}) catch
        return error.InvalidJson) {
        .object => |obj| obj,
        else => return error.InvalidManifest,
    };

    var manifest: Manifest = .{};
    manifest.scale = uintField(root, "scale") orelse return error.InvalidManifest;
    manifest.frame_size = uintField(root, "frameSize") orelse return error.InvalidManifest;
    if (manifest.scale == 0 or manifest.frame_size == 0) return error.InvalidManifest;

    const pets_value = root.get("pets") orelse return error.InvalidManifest;
    const pets = switch (pets_value) {
        .object => |obj| obj,
        else => return error.InvalidManifest,
    };
    var pet_it = pets.iterator();
    while (pet_it.next()) |pet_kv| {
        if (manifest.pet_count == max_pets) return error.TooManyPets;
        const entry = &manifest.pets[manifest.pet_count];
        entry.id = pet_kv.key_ptr.*;
        const moods = switch (pet_kv.value_ptr.*) {
            .object => |pet_obj| switch (pet_obj.get("moods") orelse return error.InvalidManifest) {
                .object => |mood_obj| mood_obj,
                else => return error.InvalidManifest,
            },
            else => return error.InvalidManifest,
        };
        // Every declared mood name must be a known Mood, and every
        // known Mood must be present.
        var seen = [_]bool{false} ** mood_count;
        var mood_it = moods.iterator();
        while (mood_it.next()) |mood_kv| {
            const mood = Mood.fromString(mood_kv.key_ptr.*) orelse return error.InvalidManifest;
            const strip_obj = switch (mood_kv.value_ptr.*) {
                .object => |obj| obj,
                else => return error.InvalidManifest,
            };
            const frames = uintField(strip_obj, "frames") orelse return error.InvalidManifest;
            const duration = floatField(strip_obj, "frameDurationMs") orelse return error.InvalidManifest;
            const file = switch (strip_obj.get("file") orelse return error.InvalidManifest) {
                .string => |s| s,
                else => return error.InvalidManifest,
            };
            if (frames == 0 or duration <= 0 or file.len == 0) return error.InvalidManifest;
            entry.strips[@intFromEnum(mood)] = .{
                .file = file,
                .frames = frames,
                .frame_duration_ms = duration,
            };
            seen[@intFromEnum(mood)] = true;
        }
        for (seen) |s| if (!s) return error.InvalidManifest;
        manifest.pet_count += 1;
    }
    if (manifest.pet_count == 0) return error.InvalidManifest;
    return manifest;
}

fn uintField(obj: std.json.ObjectMap, name: []const u8) ?u32 {
    const value = obj.get(name) orelse return null;
    return switch (value) {
        .integer => |i| if (i >= 0) @intCast(i) else null,
        .float => |f| if (f >= 0) @intFromFloat(f) else null,
        else => null,
    };
}

fn floatField(obj: std.json.ObjectMap, name: []const u8) ?f64 {
    const value = obj.get(name) orelse return null;
    return switch (value) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => null,
    };
}

// ---------------------------------------------------------------------
// Process-wide loaded manifest. Parsed once at boot (a 3 KiB read on
// the installing frame); the model keeps indices into it, never copies.

var arena_state = std.heap.ArenaAllocator.init(std.heap.page_allocator);
var loaded: ?Manifest = null;

pub fn load(path: []const u8) !void {
    var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
    defer threaded.deinit();
    const source = try std.Io.Dir.cwd().readFileAlloc(threaded.io(), path, arena_state.allocator(), .limited(1024 * 1024));
    loaded = try parse(arena_state.allocator(), source);
}

/// The boot-parsed manifest, or null when the read/parse failed (the
/// app still runs — the bridge works, the canvas just draws nothing).
pub fn current() ?*const Manifest {
    return if (loaded) |*m| m else null;
}

// ---------------------------------------------------------------------
// Id mapping and animation arithmetic (pure, unit-tested).

pub fn imageId(pet_index: usize, mood: Mood) u64 {
    return image_id_base + @as(u64, pet_index) * image_id_stride + @intFromEnum(mood);
}

/// Inverse of imageId; null for ids outside the sprite namespace.
pub fn decodeImageId(id: u64) ?struct { pet: usize, mood: Mood } {
    if (id < image_id_base) return null;
    const offset = id - image_id_base;
    const pet = offset / image_id_stride;
    const mood_index = offset % image_id_stride;
    if (pet >= max_pets or mood_index >= mood_count) return null;
    return .{ .pet = pet, .mood = @enumFromInt(mood_index) };
}

/// The repeating-timer interval for a strip: manifest float ms rounded
/// to the nearest whole millisecond, floor of 1ms.
pub fn timerIntervalMs(entry: StripEntry) u32 {
    if (entry.frame_duration_ms < 1) return 1;
    return @intFromFloat(@round(entry.frame_duration_ms));
}

/// Advance one frame, wrapping the strip.
pub fn nextFrame(frame: u32, frames: u32) u32 {
    if (frames == 0) return 0;
    return (frame + 1) % frames;
}

/// Physical-pixel width of one frame in a decoded strip. Frames are
/// square, so the decoded height IS the frame size; using the reported
/// (post decode-to-fit) height keeps crops right even if a future
/// oversized strip gets scaled down by the codec.
pub fn framePixels(decoded_height: usize) f32 {
    return @floatFromInt(decoded_height);
}

/// The source-crop x offset of frame `frame` in decoded pixels.
pub fn frameOriginX(frame: u32, decoded_height: usize) f32 {
    return @as(f32, @floatFromInt(frame)) * framePixels(decoded_height);
}

test "parse a minimal manifest and index into it" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const source =
        \\{"scale":2,"frameSize":128,"pets":{"blob":{"moods":{
        \\  "idle":{"file":"blob/idle.png","frames":24,"frameDurationMs":250},
        \\  "thinking":{"file":"blob/thinking.png","frames":24,"frameDurationMs":100},
        \\  "working":{"file":"blob/working.png","frames":4,"frameDurationMs":87.5},
        \\  "waiting":{"file":"blob/waiting.png","frames":18,"frameDurationMs":88.889},
        \\  "sad":{"file":"blob/sad.png","frames":4,"frameDurationMs":90},
        \\  "sleeping":{"file":"blob/sleeping.png","frames":24,"frameDurationMs":200},
        \\  "celebrating":{"file":"blob/celebrating.png","frames":7,"frameDurationMs":85.714},
        \\  "pet":{"file":"blob/pet.png","frames":6,"frameDurationMs":83.333}
        \\}},"cat":{"moods":{
        \\  "idle":{"file":"cat/idle.png","frames":24,"frameDurationMs":250},
        \\  "thinking":{"file":"cat/thinking.png","frames":24,"frameDurationMs":100},
        \\  "working":{"file":"cat/working.png","frames":4,"frameDurationMs":87.5},
        \\  "waiting":{"file":"cat/waiting.png","frames":18,"frameDurationMs":88.889},
        \\  "sad":{"file":"cat/sad.png","frames":4,"frameDurationMs":90},
        \\  "sleeping":{"file":"cat/sleeping.png","frames":24,"frameDurationMs":200},
        \\  "celebrating":{"file":"cat/celebrating.png","frames":7,"frameDurationMs":85.714},
        \\  "pet":{"file":"cat/pet.png","frames":6,"frameDurationMs":83.333}
        \\}}}}
    ;
    const m = try parse(arena.allocator(), source);
    try std.testing.expectEqual(2, m.scale);
    try std.testing.expectEqual(128, m.frame_size);
    try std.testing.expectEqual(2, m.pet_count);
    try std.testing.expectEqual(0, m.petIndex("blob").?);
    try std.testing.expectEqual(1, m.petIndex("cat").?);
    try std.testing.expect(m.petIndex("dog") == null);
    const strip = m.strip(0, .celebrating);
    try std.testing.expectEqual(7, strip.frames);
    try std.testing.expectEqualStrings("blob/celebrating.png", strip.file);
}

test "parse rejects incomplete mood sets, unknown moods, and bad values" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    // Missing "pet" mood.
    try std.testing.expectError(error.InvalidManifest, parse(arena.allocator(),
        \\{"scale":2,"frameSize":128,"pets":{"blob":{"moods":{
        \\  "idle":{"file":"b/idle.png","frames":1,"frameDurationMs":100},
        \\  "thinking":{"file":"b/t.png","frames":1,"frameDurationMs":100},
        \\  "working":{"file":"b/w.png","frames":1,"frameDurationMs":100},
        \\  "waiting":{"file":"b/wa.png","frames":1,"frameDurationMs":100},
        \\  "sad":{"file":"b/s.png","frames":1,"frameDurationMs":100},
        \\  "sleeping":{"file":"b/sl.png","frames":1,"frameDurationMs":100},
        \\  "celebrating":{"file":"b/c.png","frames":1,"frameDurationMs":100}
        \\}}}}
    ));
    // Unknown mood name.
    try std.testing.expectError(error.InvalidManifest, parse(arena.allocator(),
        \\{"scale":2,"frameSize":128,"pets":{"blob":{"moods":{
        \\  "idle":{"file":"b/idle.png","frames":1,"frameDurationMs":100},
        \\  "thinking":{"file":"b/t.png","frames":1,"frameDurationMs":100},
        \\  "working":{"file":"b/w.png","frames":1,"frameDurationMs":100},
        \\  "waiting":{"file":"b/wa.png","frames":1,"frameDurationMs":100},
        \\  "sad":{"file":"b/s.png","frames":1,"frameDurationMs":100},
        \\  "sleeping":{"file":"b/sl.png","frames":1,"frameDurationMs":100},
        \\  "celebrating":{"file":"b/c.png","frames":1,"frameDurationMs":100},
        \\  "pet":{"file":"b/p.png","frames":1,"frameDurationMs":100},
        \\  "dancing":{"file":"b/d.png","frames":1,"frameDurationMs":100}
        \\}}}}
    ));
    // Zero frames.
    try std.testing.expectError(error.InvalidManifest, parse(arena.allocator(),
        \\{"scale":2,"frameSize":128,"pets":{"blob":{"moods":{
        \\  "idle":{"file":"b/idle.png","frames":0,"frameDurationMs":100},
        \\  "thinking":{"file":"b/t.png","frames":1,"frameDurationMs":100},
        \\  "working":{"file":"b/w.png","frames":1,"frameDurationMs":100},
        \\  "waiting":{"file":"b/wa.png","frames":1,"frameDurationMs":100},
        \\  "sad":{"file":"b/s.png","frames":1,"frameDurationMs":100},
        \\  "sleeping":{"file":"b/sl.png","frames":1,"frameDurationMs":100},
        \\  "celebrating":{"file":"b/c.png","frames":1,"frameDurationMs":100},
        \\  "pet":{"file":"b/p.png","frames":1,"frameDurationMs":100}
        \\}}}}
    ));
    try std.testing.expectError(error.InvalidJson, parse(arena.allocator(), "not json"));
}

test "image ids round-trip and stay clear of the timer/channel keys" {
    for (0..max_pets) |pet| {
        inline for (@typeInfo(Mood).@"enum".fields) |field| {
            const mood: Mood = @enumFromInt(field.value);
            const id = imageId(pet, mood);
            try std.testing.expect(id > 5); // timer keys 1..5 live below the base
            const decoded = decodeImageId(id).?;
            try std.testing.expectEqual(pet, decoded.pet);
            try std.testing.expectEqual(mood, decoded.mood);
        }
    }
    try std.testing.expect(decodeImageId(1) == null);
    try std.testing.expect(decodeImageId(image_id_base + max_pets * image_id_stride) == null);
    // Distinct (pet, mood) pairs never share an id.
    try std.testing.expect(imageId(0, .idle) != imageId(1, .idle));
    try std.testing.expect(imageId(0, .idle) != imageId(0, .thinking));
}

test "animation arithmetic: interval rounding, frame wrap, crop stride" {
    try std.testing.expectEqual(250, timerIntervalMs(.{ .frame_duration_ms = 250 }));
    try std.testing.expectEqual(88, timerIntervalMs(.{ .frame_duration_ms = 87.5 }));
    try std.testing.expectEqual(89, timerIntervalMs(.{ .frame_duration_ms = 88.889 }));
    try std.testing.expectEqual(1, timerIntervalMs(.{ .frame_duration_ms = 0.2 }));

    try std.testing.expectEqual(1, nextFrame(0, 24));
    try std.testing.expectEqual(0, nextFrame(23, 24));
    try std.testing.expectEqual(0, nextFrame(0, 0));

    // 24 frames of 256px decode to a 6144x256 strip: frame 5 crops at x=1280.
    try std.testing.expectEqual(256, framePixels(256));
    try std.testing.expectEqual(1280, frameOriginX(5, 256));
}
