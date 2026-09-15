/**
 * Run `zig <args>` when a zig toolchain is on PATH; otherwise skip — or, when
 * the caller says zig is required, fail.
 *
 * This replaces the `command -v zig && zig build … || echo skip` one-liners
 * the package scripts used to be. Those had two problems. A `||` after the
 * zig invocation catches a *failing* zig build or test as well as a missing
 * zig, so a red test printed "skip" and exited 0. And on a CI runner without
 * zig the skip was silent, so the desktop tests could vanish from CI without
 * anyone noticing. Here the missing-toolchain case is the only one that
 * skips, zig's own exit code is passed through untouched, and
 * `DSH_REQUIRE_ZIG=1` turns the skip into a failure.
 *
 * The switch is an explicit variable rather than the ambient `CI=true` on
 * purpose: the workspace-wide `bun run build` runs on ubuntu runners (the
 * check and engines-floor jobs, publish.yml's gate) where zig is absent and
 * could not build this package anyway — src/windowing.zig only accepts macOS
 * and Windows targets — so there the skip is the correct outcome. Only the
 * macOS job that exists to run these tests sets the variable.
 *
 * Usage: node scripts/zig.mjs build
 *        node scripts/zig.mjs build test
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: node scripts/zig.mjs <zig args…>')
  process.exit(2)
}

const names = process.platform === 'win32' ? ['zig.exe', 'zig.cmd', 'zig'] : ['zig']
const zig = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((dir) => dir !== '')
  .flatMap((dir) => names.map((name) => join(dir, name)))
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    } catch {
      return false
    }
  })

if (zig === undefined) {
  if (process.env.DSH_REQUIRE_ZIG === '1') {
    console.error(
      `zig is not on PATH, and DSH_REQUIRE_ZIG=1 forbids skipping \`zig ${args.join(' ')}\` (see README)`,
    )
    process.exit(1)
  }
  console.log(`skip: zig not installed (see README); \`zig ${args.join(' ')}\` did not run`)
  process.exit(0)
}

const result = spawnSync(zig, args, { stdio: 'inherit' })
if (result.error !== undefined) {
  console.error(`could not start ${zig}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
