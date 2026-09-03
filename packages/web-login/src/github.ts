/**
 * GitHub.com OAuth Web Application Flow helpers.
 *
 * Endpoints are compile-time constants on purpose: MVP deliberately refuses
 * configurable OAuth hosts so a misconfiguration cannot become an SSRF. Access
 * tokens exist only inside the calling function; callers are expected to revoke
 * them before creating a local session.
 *
 * @module @seaveyon/dsh-web-login/github
 */

/** Fixed GitHub.com hosts. Never derived from request input. */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'
export const GITHUB_API_VERSION = '2022-11-28'
export const GITHUB_USER_AGENT = 'dsh-web-login'

/** Hard caps on GitHub response bodies. */
export const MAX_TOKEN_BODY_BYTES = 8 * 1024
export const MAX_USER_BODY_BYTES = 64 * 1024

/** Identity returned by a successful `GET /user`. */
export interface GitHubUser {
  id: number
  login: string
}

/** Credentials needed to talk to GitHub as an OAuth App. */
export interface GitHubAppCredentials {
  clientId: string
  clientSecret: string
}

/** Options shared by every outbound GitHub call. */
export interface GitHubRequestOptions {
  timeoutMs: number
  fetchImpl?: typeof fetch
}

/** Why a GitHub call failed, as a stable machine-readable code. */
export type GitHubErrorCode =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'body_too_large'
  | 'malformed'
  | 'missing_token'
  | 'missing_user_id'

/** A failed GitHub interaction. */
export class GitHubRequestError extends Error {
  readonly code: GitHubErrorCode
  readonly status?: number

  constructor(code: GitHubErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'GitHubRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * Build the browser redirect URL for the authorization step.
 *
 * @param input - client id, redirect URI, state, and PKCE challenge.
 * @returns the absolute GitHub authorize URL.
 */
export function buildAuthorizeUrl(input: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // Empty scope: public identity only.
  url.searchParams.set('scope', '')
  return url.toString()
}

/**
 * Read a response body with a hard byte cap.
 * @param response - the fetch response.
 * @param limit - maximum accepted bytes.
 * @returns the body text.
 */
async function readCappedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw new GitHubRequestError('body_too_large', 'GitHub response exceeded size limit')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > limit) {
      throw new GitHubRequestError('body_too_large', 'GitHub response exceeded size limit')
    }
    return text
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new GitHubRequestError('body_too_large', 'GitHub response exceeded size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/**
 * Perform a GitHub HTTPS request with timeout, Accept, and no cross-host redirects.
 * @param url - absolute GitHub URL.
 * @param init - fetch init without signal (timeout is owned here).
 * @param options - timeout and injectable fetch.
 * @returns the response.
 */
async function githubFetch(
  url: string,
  init: RequestInit,
  options: GitHubRequestOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': GITHUB_USER_AGENT,
        'x-github-api-version': GITHUB_API_VERSION,
        ...init.headers,
      },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GitHubRequestError('timeout', 'GitHub request timed out')
    }
    throw new GitHubRequestError(
      'network',
      error instanceof Error ? error.message : 'GitHub request failed',
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Exchange an authorization code for an access token.
 *
 * @param input - code, PKCE verifier, redirect URI, and app credentials.
 * @param options - timeout and injectable fetch.
 * @returns the access token string.
 */
export async function exchangeCode(input: {
  code: string
  codeVerifier: string
  redirectUri: string
  credentials: GitHubAppCredentials
  options: GitHubRequestOptions
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: input.credentials.clientId,
    client_secret: input.credentials.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  })
  const response = await githubFetch(
    GITHUB_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    input.options,
  )
  const text = await readCappedText(response, MAX_TOKEN_BODY_BYTES)
  if (!response.ok) {
    throw new GitHubRequestError('http_status', 'GitHub token exchange failed', response.status)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GitHubRequestError('malformed', 'GitHub token response was not JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new GitHubRequestError('malformed', 'GitHub token response was not an object')
  }
  const token = (parsed as Record<string, unknown>).access_token
  if (typeof token !== 'string' || token === '') {
    throw new GitHubRequestError('missing_token', 'GitHub token response omitted access_token')
  }
  return token
}

/**
 * Fetch the authenticated GitHub user.
 *
 * @param accessToken - bearer token from {@link exchangeCode}.
 * @param options - timeout and injectable fetch.
 * @returns the numeric id and login.
 */
export async function fetchGitHubUser(
  accessToken: string,
  options: GitHubRequestOptions,
): Promise<GitHubUser> {
  const response = await githubFetch(
    GITHUB_USER_URL,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    },
    options,
  )
  const text = await readCappedText(response, MAX_USER_BODY_BYTES)
  if (!response.ok) {
    throw new GitHubRequestError('http_status', 'GitHub user lookup failed', response.status)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GitHubRequestError('malformed', 'GitHub user response was not JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new GitHubRequestError('malformed', 'GitHub user response was not an object')
  }
  const record = parsed as Record<string, unknown>
  const id = record.id
  const login = record.login
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new GitHubRequestError('missing_user_id', 'GitHub user response omitted a numeric id')
  }
  if (typeof login !== 'string' || login === '' || login.length > 64) {
    throw new GitHubRequestError('malformed', 'GitHub user response omitted a usable login')
  }
  return { id, login }
}

/**
 * Revoke a single OAuth access token for this app.
 *
 * @param accessToken - the token to revoke.
 * @param credentials - OAuth App client id and secret.
 * @param options - timeout and injectable fetch.
 */
export async function revokeAccessToken(
  accessToken: string,
  credentials: GitHubAppCredentials,
  options: GitHubRequestOptions,
): Promise<void> {
  const url = `https://api.github.com/applications/${encodeURIComponent(credentials.clientId)}/token`
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    'base64',
  )
  const response = await githubFetch(
    url,
    {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
    options,
  )
  // 204 No Content is the success case; 404 means the token is already gone.
  if (response.status === 204 || response.status === 404) {
    // Drain without retaining: never log the body.
    await readCappedText(response, MAX_TOKEN_BODY_BYTES).catch(() => '')
    return
  }
  await readCappedText(response, MAX_TOKEN_BODY_BYTES).catch(() => '')
  throw new GitHubRequestError('http_status', 'GitHub token revocation failed', response.status)
}

/**
 * A small concurrency gate for callback-time GitHub work.
 *
 * @param max - maximum concurrent holders.
 * @returns acquire / release helpers.
 */
export function createConcurrencyGate(max: number): {
  tryAcquire: () => boolean
  release: () => void
  readonly active: number
} {
  let active = 0
  return {
    tryAcquire() {
      if (active >= max) return false
      active += 1
      return true
    },
    release() {
      if (active > 0) active -= 1
    },
    get active() {
      return active
    },
  }
}
