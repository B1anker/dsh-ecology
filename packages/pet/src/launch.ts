/**
 * The desktop-app launcher behind `POST /dsh-pet/launch-desktop`.
 *
 * The settings panel cannot start a local process from a browser page, but the
 * host face runs inside the DSH server — which, for a loopback page, is the
 * user's own machine. This module is the seam: the panel POSTs the route when
 * the summon button is pressed, and the handler starts the desktop app.
 *
 * Three ways to find the app, in order:
 *
 * 1. The per-platform optional dependency
 *    (`@seaveyon/dsh-pet-desktop-<platform>-<arch>`, resolved through the
 *    package's exports map). npm's os/cpu selectors install only the one
 *    package matching the user's machine, so a macOS arm64 install downloads
 *    no Windows or Intel bytes. The platform build wins over any installed
 *    copy because it is version-locked to this plugin — the
 *    optionalDependencies entry names an exact version, so the /state
 *    contract (MOODS order, bridge port) can never drift between the two
 *    sides. On macOS it is also the path with no Gatekeeper friction:
 *    npm-installed files carry no quarantine attribute, so an unsigned binary
 *    spawns cleanly.
 * 2. The legacy staging directory inside this package
 *    (`desktop/dsh-pet-desktop-*`), which only exists in a development
 *    checkout after `bun run build:desktop`; the published tarball no longer
 *    carries it. The sprite assets stay here (`desktop/assets/`) — they are
 *    shared by every platform — and the spawn sets DSH_PET_DESKTOP_ASSETS to
 *    point the binary at them, because the exe now lives in a different
 *    package than its sprites.
 * 3. An installed copy, per platform. On macOS, Launch Services (`open -b`
 *    the bundle id, then the standard Applications folders) — development
 *    installs and pre-split packages. On Windows there is no `open -b` and
 *    no installer, so the fallback is the DSH_PET_DESKTOP_APP environment
 *    variable pointing at an exe.
 *
 * Three guards, each cheap and each covering a distinct abuse:
 *
 * - POST only, and the custom `x-dsh-pet-launch` header is mandatory. A custom
 *   header forces a CORS preflight on every cross-origin request, and this
 *   route never answers OPTIONS — so a random website cannot drive-by launch
 *   the app through the user's browser (the request would come from loopback,
 *   making the remote-address check below insufficient on its own).
 * - The peer must be loopback: launching makes sense only when the DSH server
 *   and the browser share the machine, and it keeps remote-host deployments
 *   from starting the pet on a server nobody is watching.
 * - Behind the web-login gate: the cordis.patch.yml row injects
 *   `dshWebLoginReady`, so on gated profiles the request must also carry a
 *   valid session cookie.
 *
 * @module @seaveyon/dsh-pet/launch
 */

/// <reference types="node" />

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { RouteHandler } from './host-types.js'

/** The exact route the host face registers and the panel POSTs. */
export const LAUNCH_ROUTE_PATH = '/dsh-pet/launch-desktop'

/** Cross-origin drive-by fence: the request must carry this header. */
export const LAUNCH_HEADER = 'x-dsh-pet-launch'

/**
 * The desktop binary staged inside this package for one platform and
 * architecture: `desktop/dsh-pet-desktop-<arch>` on macOS and
 * `desktop/dsh-pet-desktop-windows-<arch>.exe` on Windows, where `<arch>` is
 * the Node `process.arch` spelling (arm64, x64), so selection is a template
 * with no mapping table to drift. Resolved from this module's own URL so the
 * same layout holds from src/ (tests) and dist/ (an installed package): both
 * sit one level below the package root. Only a development checkout has this
 * directory — `bun run build:desktop` stages it — so on an installed package
 * the lookup simply misses and the rest of the chain runs; the published
 * binary rides in the per-platform optional package instead, resolved by
 * {@link platformPackageBinary}.
 */
export function bundledDesktopBinary(
  arch: NodeJS.Process['arch'] = process.arch,
  platform: NodeJS.Platform = process.platform,
): string {
  const name =
    platform === 'win32' ? `dsh-pet-desktop-windows-${arch}.exe` : `dsh-pet-desktop-${arch}`
  return fileURLToPath(new URL(`../desktop/${name}`, import.meta.url))
}

/**
 * The desktop binary carried by this host's per-platform optional dependency,
 * `@seaveyon/dsh-pet-desktop-<platform>-<arch>`, in the Node
 * `process.platform`/`process.arch` spellings so selection stays a template.
 * Resolution goes through the package's exports map (`./package.json` is the
 * only export) rather than guessing a node_modules layout, and the binary
 * inside is `bin/dsh-pet-desktop` (`bin/dsh-pet-desktop.exe` on Windows) —
 * the package name already carries the platform and architecture. Returns
 * null when the package is absent: a platform without a build, an install
 * that skipped optional dependencies, or a source checkout before
 * `bun install`. Called lazily from the launch path, never at module scope —
 * `scripts/smoke-tarball.mjs` cold-imports this module in a directory with no
 * node_modules, where any top-level resolution would throw.
 */
export function platformPackageBinary(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Process['arch'] = process.arch,
): string | null {
  const name = `@seaveyon/dsh-pet-desktop-${platform}-${arch}`
  try {
    const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`)
    const exe = platform === 'win32' ? 'dsh-pet-desktop.exe' : 'dsh-pet-desktop'
    return join(dirname(manifest), 'bin', exe)
  } catch {
    return null
  }
}

/**
 * The sprite assets shared by every platform build, shipped inside this
 * package at `desktop/assets/`. The binary lives in a different package now,
 * so the spawn environment names this directory through
 * DSH_PET_DESKTOP_ASSETS — see {@link desktopAssetsEnv}.
 */
export function desktopAssetsDir(): string {
  return fileURLToPath(new URL('../desktop/assets', import.meta.url))
}

/**
 * The environment addition that points a spawned desktop binary at its
 * sprites: `{ DSH_PET_DESKTOP_ASSETS: <this package>/desktop/assets }` when
 * that directory exists, `{}` otherwise (a development checkout before
 * `build:desktop`, where the exe's own probing finds assets beside the staged
 * binary). Factored out of the spawn so tests can assert the computation
 * without starting a process.
 */
export function desktopAssetsEnv(
  exists: (path: string) => boolean = existsSync,
): Record<string, string> {
  const dir = desktopAssetsDir()
  return exists(dir) ? { DSH_PET_DESKTOP_ASSETS: dir } : {}
}

/**
 * Bundle id the packaged desktop app registers
 * (packages/pet-desktop/app.zon). Launch Services resolves it wherever the
 * .app lives, so it is tried before any hard-coded path.
 */
export const DESKTOP_BUNDLE_ID = 'dev.seaveyon.dsh-pet-desktop'

export type LaunchOutcome = 'launched' | 'not-installed' | 'unsupported-platform' | 'launch-failed'

/** Every effectful seam, injectable so tests never touch Launch Services. */
export interface LaunchDeps {
  platform?: NodeJS.Platform
  /** Defaults to `process.arch`; selects which platform-package and staged binary runs. */
  arch?: NodeJS.Process['arch']
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  /** Resolves on exit code 0, rejects otherwise. Defaults to execFile. */
  run?: (command: string, args: string[]) => Promise<void>
  /**
   * The per-platform optional dependency's binary, tried before everything
   * else; null disables the lookup. Defaults to {@link platformPackageBinary}
   * for the host platform and arch.
   */
  platformBinary?: string | null
  /**
   * The staged `desktop/` binary to try after the platform package; null
   * disables the lookup. Defaults to {@link bundledDesktopBinary} for the
   * host platform and arch.
   */
  bundledBinary?: string | null
  /**
   * Starts a desktop binary as a detached child that outlives the request
   * (and even the DSH server). Resolves once the process is spawned, rejects
   * on spawn error. Defaults to a detached, stdio-ignored spawn whose
   * environment points DSH_PET_DESKTOP_ASSETS at this package's
   * `desktop/assets/` — the exe lives in a different package than its
   * sprites, so without the variable its own probing would find nothing.
   */
  spawnDetached?: (path: string) => Promise<void>
}

async function defaultRun(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => (error === null ? resolve() : reject(error)))
  })
}

async function defaultSpawnDetached(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(path, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...desktopAssetsEnv() },
    })
    child.once('error', reject)
    child.once('spawn', () => resolve())
    child.unref()
  })
}

/** Spawn one binary, mapping a spawn failure onto the outcome vocabulary. */
async function spawnOutcome(
  path: string,
  spawnDetached: (path: string) => Promise<void>,
): Promise<LaunchOutcome> {
  try {
    await spawnDetached(path)
    return 'launched'
  } catch {
    return 'launch-failed'
  }
}

/** Candidate .app locations on macOS, in the order they are tried. */
export function launchCandidates(deps: LaunchDeps = {}): string[] {
  const env = deps.env ?? process.env
  const home = deps.home ?? process.env.HOME ?? ''
  const fromEnv = env.DSH_PET_DESKTOP_APP
  return [
    ...(fromEnv === undefined || fromEnv === '' ? [] : [fromEnv]),
    '/Applications/DSH Pet.app',
    ...(home === '' ? [] : [join(home, 'Applications', 'DSH Pet.app')]),
  ]
}

/**
 * Start the desktop app. The version-locked builds win because the bridge
 * contract can never drift from this plugin: first the per-platform optional
 * dependency's binary, then a development checkout's staged `desktop/` copy.
 * After that the fallback is platform-shaped. On macOS the bundle-id query
 * covers any install location Launch Services knows, and the path list
 * covers a freshly downloaded copy it has not indexed yet, with
 * DSH_PET_DESKTOP_APP heading the path search (development and non-standard
 * installs). On Windows there is no `open -b` and no installer record, so
 * DSH_PET_DESKTOP_APP pointing at an exe is the whole fallback.
 */
export async function launchDesktopApp(deps: LaunchDeps = {}): Promise<LaunchOutcome> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported-platform'
  const exists = deps.exists ?? existsSync
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached

  const platformBinary =
    deps.platformBinary === undefined
      ? platformPackageBinary(platform, deps.arch)
      : deps.platformBinary
  if (platformBinary !== null && exists(platformBinary)) {
    return spawnOutcome(platformBinary, spawnDetached)
  }

  const bundled =
    deps.bundledBinary === undefined
      ? bundledDesktopBinary(deps.arch, platform)
      : deps.bundledBinary
  if (bundled !== null && exists(bundled)) {
    return spawnOutcome(bundled, spawnDetached)
  }

  if (platform === 'win32') {
    const fromEnv = (deps.env ?? process.env).DSH_PET_DESKTOP_APP
    if (fromEnv === undefined || fromEnv === '' || !exists(fromEnv)) return 'not-installed'
    return spawnOutcome(fromEnv, spawnDetached)
  }

  const run = deps.run ?? defaultRun
  try {
    await run('open', ['-b', DESKTOP_BUNDLE_ID])
    return 'launched'
  } catch {
    // Not indexed (or never installed): fall through to the path search.
  }
  for (const candidate of launchCandidates(deps)) {
    if (!exists(candidate)) continue
    try {
      await run('open', [candidate])
      return 'launched'
    } catch {
      return 'launch-failed'
    }
  }
  return 'not-installed'
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length })
  res.end(payload)
}

/**
 * The route handler. Guards first (cheapest and most specific last), then the
 * launch attempt; the outcome maps to a status the panel can tell apart —
 * 404 is "go download it", everything else non-2xx is "try manually".
 */
export function createLaunchHandler(deps: LaunchDeps = {}): RouteHandler {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (req.headers[LAUNCH_HEADER] !== '1') {
      sendJson(res, 400, { ok: false, error: 'missing_header' })
      return
    }
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      sendJson(res, 403, { ok: false, error: 'loopback_only' })
      return
    }
    switch (await launchDesktopApp(deps)) {
      case 'launched':
        sendJson(res, 200, { ok: true })
        return
      case 'not-installed':
        sendJson(res, 404, { ok: false, error: 'not_installed' })
        return
      case 'unsupported-platform':
        sendJson(res, 501, { ok: false, error: 'unsupported_platform' })
        return
      default:
        sendJson(res, 500, { ok: false, error: 'launch_failed' })
    }
  }
}
