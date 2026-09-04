/**
 * Client half of the desktop launcher.
 *
 * The browser cannot start a local process, so launching the desktop app goes
 * through the host face's route (see src/launch.ts for the server side and its
 * guards): the panel POSTs same-origin with the session cookie and the
 * mandatory custom header, and maps the status to a result it can word —
 * 404 means "not installed, offer the download", anything else means "the
 * host could not help, tell the user to open the app by hand".
 *
 * The button is only ever shown on loopback pages: against a remote host the
 * route would start the pet on the server, which is nobody's desktop. That is
 * a display decision, not a security boundary — the server re-checks the
 * peer address itself.
 *
 * @module @seaveyon/dsh-pet/client/launch
 */

/** The host face's launch route (src/launch.ts owns the path). */
export const LAUNCH_DESKTOP_PATH = '/dsh-pet/launch-desktop'

/** Where the "not installed" answer sends the user. */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/B1anker/dsh-ecology/releases'

export type LaunchRequestResult = 'launched' | 'not-installed' | 'unavailable'

/**
 * True when this page is served from the machine the user is sitting at.
 * `location.hostname` renders IPv6 loopback as `[::1]`.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

export interface RequestLaunchOptions {
  /** Defaults to the global fetch; injectable for tests. */
  fetchFn?: typeof fetch
}

/**
 * Ask the host to launch the desktop app. Never throws: a shell old enough to
 * lack the route answers 404 the same as "not installed", and a network-level
 * failure is indistinguishable from a dying server — both are 'unavailable'.
 */
export async function requestDesktopLaunch(
  options: RequestLaunchOptions = {},
): Promise<LaunchRequestResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchFn(LAUNCH_DESKTOP_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-dsh-pet-launch': '1' },
    })
    if (response.ok) return 'launched'
    if (response.status === 404) {
      // The launcher reports a missing app as 404 {error: 'not_installed'};
      // any other 404 (an older host without the route, an SPA fallback's
      // HTML) means the host could not help rather than "go download".
      try {
        const body: unknown = await response.json()
        if (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['error'] === 'not_installed'
        ) {
          return 'not-installed'
        }
      } catch {
        // Not JSON — not the launcher talking.
      }
      return 'unavailable'
    }
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}
