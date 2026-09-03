/**
 * Fetch the host-side session summary used by the account panel.
 *
 * @module @seaveyon/dsh-web-login/client/session
 */

/** Authorization posture summarized for the settings panel. */
export type SessionAuthStatus = 'password_only' | 'awaiting_github_bind' | 'github_bound'

/** JSON body from `GET /auth/session`. */
export interface SessionInfo {
  provider: 'password' | 'password-bootstrap' | 'github' | 'recovery'
  role: 'owner' | 'member'
  githubUserId: number | null
  githubLogin: string | null
  githubEnabled: boolean
  canBindGitHub: boolean
  status: SessionAuthStatus
  enrolledAt: string | null
  lastLoginAt: string | null
  sessionExpiresAt: string
  sessionRemainingMs: number
  githubClientId: string | null
  /** Numeric id for `/settings/applications/{id}`; null when not configured. */
  githubOAuthAppId: number | null
}

/**
 * Load the current authenticated session.
 * @returns the session payload, or null when the request fails / is unauthorized.
 */
export async function fetchSessionInfo(): Promise<SessionInfo | null> {
  try {
    const response = await fetch('/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<SessionInfo>
    if (
      body.provider !== 'password' &&
      body.provider !== 'password-bootstrap' &&
      body.provider !== 'github' &&
      body.provider !== 'recovery'
    ) {
      return null
    }
    if (body.role !== 'owner' && body.role !== 'member') return null
    if (
      body.status !== 'password_only' &&
      body.status !== 'awaiting_github_bind' &&
      body.status !== 'github_bound'
    ) {
      return null
    }
    if (typeof body.sessionExpiresAt !== 'string' || body.sessionExpiresAt === '') return null
    if (typeof body.sessionRemainingMs !== 'number' || !Number.isFinite(body.sessionRemainingMs)) {
      return null
    }
    return {
      provider: body.provider,
      role: body.role,
      githubUserId: typeof body.githubUserId === 'number' ? body.githubUserId : null,
      githubLogin: typeof body.githubLogin === 'string' ? body.githubLogin : null,
      githubEnabled: body.githubEnabled === true,
      canBindGitHub: body.canBindGitHub === true,
      status: body.status,
      enrolledAt: typeof body.enrolledAt === 'string' ? body.enrolledAt : null,
      lastLoginAt: typeof body.lastLoginAt === 'string' ? body.lastLoginAt : null,
      sessionExpiresAt: body.sessionExpiresAt,
      sessionRemainingMs: Math.max(0, body.sessionRemainingMs),
      githubClientId: typeof body.githubClientId === 'string' ? body.githubClientId : null,
      githubOAuthAppId:
        typeof body.githubOAuthAppId === 'number' &&
        Number.isInteger(body.githubOAuthAppId) &&
        body.githubOAuthAppId > 0
          ? body.githubOAuthAppId
          : null,
    }
  } catch {
    return null
  }
}

/**
 * Deep-link to the owned OAuth App settings page when the numeric id is known.
 *
 * GitHub's edit URL is `/settings/applications/{numericId}`. That id is not
 * derivable from Client ID via any public API, so operators paste it into
 * `githubOAuthAppId` after opening the app once. Without it, fall back to the
 * Developer settings list.
 *
 * @param appId - numeric application id, or null/undefined when unknown.
 * @returns an https URL on github.com.
 */
export function githubOAuthAppUrl(appId?: number | null): string {
  if (typeof appId === 'number' && Number.isInteger(appId) && appId > 0) {
    return `https://github.com/settings/applications/${appId}`
  }
  return 'https://github.com/settings/developers'
}
