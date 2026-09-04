/**
 * The desktop-app launcher behind `POST /dsh-pet/launch-desktop`.
 *
 * The settings panel cannot start a local process from a browser page, but the
 * host face runs inside the DSH server — which, for a loopback page, is the
 * user's own machine. This module is the seam: the panel POSTs the route when
 * the companion switch is on but the bridge port answers nothing, and the
 * handler asks macOS Launch Services to open the packaged desktop app.
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

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'

import type { RouteHandler } from './host-types.js'

/** The exact route the host face registers and the panel POSTs. */
export const LAUNCH_ROUTE_PATH = '/dsh-pet/launch-desktop'

/** Cross-origin drive-by fence: the request must carry this header. */
export const LAUNCH_HEADER = 'x-dsh-pet-launch'

/**
 * Bundle id the packaged desktop app registers
 * (packages/pet-desktop/app.zon). Launch Services resolves it wherever the
 * .app lives, so it is tried before any hard-coded path.
 */
export const DESKTOP_BUNDLE_ID = 'dev.seaveyon.dsh-pet'

export type LaunchOutcome = 'launched' | 'not-installed' | 'unsupported-platform' | 'launch-failed'

/** Every effectful seam, injectable so tests never touch Launch Services. */
export interface LaunchDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
  /** Resolves on exit code 0, rejects otherwise. Defaults to execFile. */
  run?: (command: string, args: string[]) => Promise<void>
}

async function defaultRun(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => (error === null ? resolve() : reject(error)))
  })
}

/** Candidate .app locations, in the order they are tried. */
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
 * Ask macOS to start the desktop app. The bundle-id query covers any install
 * location Launch Services knows; the path list covers a freshly downloaded
 * copy it has not indexed yet. DSH_PET_DESKTOP_APP overrides the path search
 * (development and non-standard installs).
 */
export async function launchDesktopApp(deps: LaunchDeps = {}): Promise<LaunchOutcome> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') return 'unsupported-platform'
  const exists = deps.exists ?? existsSync
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
