/**
 * HTTP helpers for the pre-authentication surface.
 *
 * Every response defined here is served to callers who have not proved who they
 * are, so each one carries the no-store/no-sniff/no-referrer set: a login page
 * cached by an intermediary, or a failed-attempt page kept in browser history,
 * outlives the request it belonged to.
 *
 * @module @seaveyon/dsh-web-login/http
 */

/**
 * Headers attached to every unauthenticated response.
 *
 * The CSP is the tight one the login page is written for: no scripts at all, no
 * framing, and a form that can only post back to this origin. `unsafe-inline`
 * appears for `style-src` only, because the page ships its stylesheet inline to
 * avoid fetching an asset from behind the gate it guards.
 */
export const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
})

/**
 * Send an HTML response with the security headers applied.
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param html - the document to send.
 * @param extra - additional headers, e.g. Set-Cookie.
 */
export function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    ...extra,
  })
  res.end(html)
}

/**
 * Send a JSON error with the security headers applied.
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param error - short machine-readable error code.
 * @param extra - additional headers, e.g. Retry-After.
 */
export function sendJsonError(res, status, error, extra = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  })
  res.end(JSON.stringify({ error }))
}

/**
 * Send a redirect with the security headers applied.
 * @param res - the server response.
 * @param status - 302 for navigation, 303 after a successful POST.
 * @param location - target path.
 * @param extra - additional headers, e.g. Set-Cookie.
 */
export function sendRedirect(res, status, location, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, location, ...extra })
  res.end()
}

/**
 * Whether a request is a browser document navigation.
 *
 * Only navigations may be redirected to the login page. A `fetch` for `/api`
 * that receives a 302 follows it and hands the SPA an HTML document where it
 * expected JSON, which surfaces to the user as a parse error rather than a
 * prompt to sign in — so everything else gets a 401 instead.
 *
 * @param req - the incoming request.
 * @returns true when a redirect to the login page is the right answer.
 */
export function isDocumentNavigation(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  // Fetch metadata is authoritative where the browser sends it and cannot be
  // set by page JavaScript; the Accept sniff is the fallback for clients that
  // predate it.
  const mode = req.headers['sec-fetch-mode']
  const dest = req.headers['sec-fetch-dest']
  if (typeof mode === 'string' || typeof dest === 'string') {
    return mode === 'navigate' && dest === 'document'
  }
  const accepts = req.headers.accept
  return typeof accepts === 'string' && accepts.includes('text/html')
}

/**
 * Identify the client for rate-limiting purposes.
 *
 * The socket address is the default because it cannot be forged by the client.
 * A forwarded header is used only when the operator has opted in, which is safe
 * exactly when the proxy overwrites that header on every request and the app is
 * unreachable except through it.
 *
 * @param req - the incoming request.
 * @param options - `trustProxy` and the `clientIpHeader` to read.
 * @returns a stable client key.
 */
export function clientKey(req, { trustProxy, clientIpHeader }) {
  if (trustProxy) {
    const raw = req.headers[clientIpHeader]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value !== '') {
      // X-Forwarded-For accumulates a list; the proxy appends the peer it saw,
      // so the last entry is the only one it vouches for.
      const hops = value.split(',')
      const nearest = hops[hops.length - 1].trim()
      if (nearest !== '') return nearest
    }
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

/**
 * Read a request body with a hard cap.
 *
 * The cap is enforced while streaming rather than after, because this runs
 * before any credential check: an unauthenticated POST must not be able to
 * become a memory sink. A declared `Content-Length` over the cap is refused
 * without reading anything at all.
 *
 * Written with explicit listeners rather than `for await`, which is the obvious
 * form and the wrong one here: returning early from a `for await` over a stream
 * invokes the iterator's `return()`, which destroys the stream — and destroying
 * an `IncomingMessage` tears down its socket, so the 413 this function exists to
 * enable would never reach the client. On refusal the stream is resumed without
 * retaining chunks: Node drains the rejected request so the response flushes and
 * a keep-alive connection cannot become desynchronized.
 *
 * @param req - the incoming request.
 * @param limit - maximum bytes to accept.
 * @returns the body as UTF-8, or null when the cap was exceeded or the client
 *   went away before the body arrived.
 */
export function readBody(req, limit) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    // Discard rather than buffer the declared body. Unlike destroy(), resume()
    // leaves the socket alive long enough for the caller to send its 413.
    req.resume()
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    let settled = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onFailed)
      req.off('aborted', onFailed)
    }

    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        // Drain the remainder without retaining it. This keeps HTTP framing
        // intact for the 413 response and any subsequent keep-alive request.
        req.resume()
        settle(null)
        return
      }
      chunks.push(chunk)
    }

    const onEnd = () => settle(Buffer.concat(chunks).toString('utf8'))

    // A client that disappears mid-body gets the same answer as one that sent
    // too much. Rejecting instead would surface as an unhandled rejection inside
    // whatever route dispatcher is hosting this handler, and the response is
    // moot either way — the socket is already gone.
    const onFailed = () => settle(null)

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onFailed)
    req.on('aborted', onFailed)
  })
}

/**
 * Whether a request body is a form submission this handler accepts.
 * @param req - the incoming request.
 * @returns true for `application/x-www-form-urlencoded`.
 */
export function isFormPost(req) {
  const type = req.headers['content-type']
  if (typeof type !== 'string') return false
  return type.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded'
}
