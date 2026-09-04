/**
 * The desktop-app launcher behind `POST /dsh-pet/launch-desktop`.
 *
 * The settings panel cannot start a local process from a browser page, but the
 * host face runs inside the DSH server — which, for a loopback page, is the
 * user's own machine. This module is the seam: the panel POSTs the route when
 * the summon button is pressed, and the handler starts the desktop app.
 *
 * Two ways to find the app, in order:
 *
 * 1. The binaries bundled inside this npm package (`desktop/dsh-pet-desktop-*`,
 *    one build per platform/architecture — macOS arm64 and x64, Windows x64 —
 *    packed by the release workflow). The bundled build wins over any
 *    installed copy because it is version-locked to this plugin — the /state
 *    contract (MOODS order, bridge port) can never drift between the two
 *    sides. On macOS it is also the path with no Gatekeeper friction:
 *    npm-installed files carry no quarantine attribute, so an unsigned binary
 *    spawns cleanly.
 * 2. An installed copy, per platform. On macOS, Launch Services (`open -b`
 *    the bundle id, then the standard Applications folders) — development
 *    installs and pre-bundle packages. On Windows there is no `open -b` and
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
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { RouteHandler } from './host-types.js'

/** The exact route the host face registers and the panel POSTs. */
export const LAUNCH_ROUTE_PATH = '/dsh-pet/launch-desktop'

/** Cross-origin drive-by fence: the request must carry this header. */
export const LAUNCH_HEADER = 'x-dsh-pet-launch'

/**
 * The desktop binary bundled into this npm package for one platform and
 * architecture: `desktop/dsh-pet-desktop-<arch>` on macOS and
 * `desktop/dsh-pet-desktop-windows-<arch>.exe` on Windows, where `<arch>` is
 * the Node `process.arch` spelling (arm64, x64), so selection is a template
 * with no mapping table to drift. Resolved from this module's own URL so the
 * same layout holds from src/ (tests) and dist/ (an installed package): both
 * sit one level below the package root. A source checkout has no desktop/
 * directory — the release workflow adds it at pack time — so the lookup
 * simply misses and the fallback chain runs; an architecture with no bundled
 * build misses the same way.
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
 * Bundle id the packaged desktop app registers
 * (packages/pet-desktop/app.zon). Launch Services resolves it wherever the
 * .app lives, so it is tried before any hard-coded path.
 */
export const DESKTOP_BUNDLE_ID = 'dev.seaveyon.dsh-pet-desktop'

export type LaunchOutcome = 'launched' | 'not-installed' | 'unsupported-platform' | 'launch-failed'

/** Every effectful seam, injectable so tests never touch Launch Services. */
export interface LaunchDeps {
  platform?: NodeJS.Platform
  /** Defaults to `process.arch`; selects which bundled binary runs. */
  arch?: NodeJS.Process['arch']
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  /** Resolves on exit code 0, rejects otherwise. Defaults to execFile. */
  run?: (command: string, args: string[]) => Promise<void>
  /**
   * The package-bundled binary to try before the platform fallback chain;
   * null disables the lookup. Defaults to {@link bundledDesktopBinary} for
   * the host platform and arch.
   */
  bundledBinary?: string | null
  /**
   * Starts the bundled binary as a detached child that outlives the request
   * (and even the DSH server). Resolves once the process is spawned, rejects
   * on spawn error. Defaults to a detached, stdio-ignored spawn.
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
    const child = spawn(path, [], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => resolve())
    child.unref()
  })
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
 * Start the desktop app. The bundled binary wins because it is version-locked
 * to this plugin; after that the fallback is platform-shaped. On macOS the
 * bundle-id query covers any install location Launch Services knows, and the
 * path list covers a freshly downloaded copy it has not indexed yet, with
 * DSH_PET_DESKTOP_APP heading the path search (development and non-standard
 * installs). On Windows there is no `open -b` and no installer record, so
 * DSH_PET_DESKTOP_APP pointing at an exe is the whole fallback.
 */
export async function launchDesktopApp(deps: LaunchDeps = {}): Promise<LaunchOutcome> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported-platform'
  const exists = deps.exists ?? existsSync

  const bundled =
    deps.bundledBinary === undefined
      ? bundledDesktopBinary(deps.arch, platform)
      : deps.bundledBinary
  if (bundled !== null && exists(bundled)) {
    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached
    try {
      await spawnDetached(bundled)
      return 'launched'
    } catch {
      return 'launch-failed'
    }
  }

  if (platform === 'win32') {
    const fromEnv = (deps.env ?? process.env).DSH_PET_DESKTOP_APP
    if (fromEnv === undefined || fromEnv === '' || !exists(fromEnv)) return 'not-installed'
    const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached
    try {
      await spawnDetached(fromEnv)
      return 'launched'
    } catch {
      return 'launch-failed'
    }
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
