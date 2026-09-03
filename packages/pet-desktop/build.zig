// dsh-pet builds through the framework's standard app graph
// (`native_sdk.addApp`): the SDK is a locked-commit tarball dependency in
// build.zig.zon (github.com/vercel-labs/zero-native @ 5665a35), and the
// graph wires the SDK modules, the app runner, and the platform link
// options. src/appkit.zig needs no link edit here: it resolves the
// Objective-C runtime with dlsym (libobjc is already in the process —
// the AppKit platform host links it).
const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    native_sdk.addApp(b, b.dependency("native_sdk", .{}), .{ .name = "dsh-pet" });
}
