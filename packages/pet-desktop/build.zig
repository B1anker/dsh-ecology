// dsh-pet-desktop builds through the framework's standard app graph
// (`native_sdk.addApp`): the SDK is a locked-commit tarball dependency in
// build.zig.zon (github.com/vercel-labs/zero-native @ 5665a35), and the
// graph wires the SDK modules, the app runner, and the platform link
// options. src/appkit.zig needs no link edit here: it resolves the
// Objective-C runtime with dlsym (libobjc is already in the process —
// the AppKit platform host links it).
const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    // Per-gesture input diagnostics (src/diag.zig): off by default so a
    // shipped pet is silent, on for a drag-jitter hunt. `addApp` takes no
    // hook for an extra module import, so this goes through
    // `addAppArtifacts` — the same graph, with the exe and test compiles
    // handed back.
    const drag_diag = b.option(bool, "drag-diag", "Log per-gesture drag/hover/facing diagnostics") orelse false;
    const options = b.addOptions();
    options.addOption(bool, "drag_diag", drag_diag);

    const app = native_sdk.addAppArtifacts(b, b.dependency("native_sdk", .{}), .{ .name = "dsh-pet-desktop" });
    app.exe.root_module.addOptions("build_options", options);
    // The tests get their own module only when the app and test optimize
    // modes differ (they do by default: ReleaseFast vs Debug). When
    // `-Doptimize` makes them equal this is the same module twice, which
    // is harmless — `addImport` is a put.
    app.tests.root_module.addOptions("build_options", options);
}
