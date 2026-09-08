import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'

/** Short-lived delegation from an authenticated local manager to one child.
 * No production session is copied or persisted. Never enabled in a formal home.
 */
export function createLabSessionGate(
  env: NodeJS.ProcessEnv,
  now = Date.now,
  nativeAuthenticated: (req: IncomingMessage) => boolean = () => false,
) {
  const id = env.WORLD_LINE_LAB ?? ''
  const secret = env.WORLD_LINE_SESSION_SECRET ?? ''
  const expires = Number(env.WORLD_LINE_SESSION_EXPIRES)
  const enabled =
    /^lab-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(id) &&
    /^[a-f0-9]{64}$/.test(secret) &&
    Number.isFinite(expires) &&
    expires > now() &&
    expires <= now() + 10 * 60_000 &&
    !!env.WORLD_LINE_MANAGER_HOME &&
    !!env.DSH_HOME &&
    resolve(env.DSH_HOME) ===
      resolve(env.WORLD_LINE_MANAGER_HOME!, 'world-line', 'labs', id, 'home')
  return (req: IncomingMessage): boolean => {
    if (!enabled || now() >= expires) return false
    const remote = req.socket.remoteAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) return false
    // The host validates its own per-process session, for HTTP and upgrades.
    // No cross-port cookie or header copying is needed and no bearer is added
    // to browser requests that can follow redirects to another origin.
    try {
      return nativeAuthenticated(req) === true
    } catch {
      return false
    }
  }
}
