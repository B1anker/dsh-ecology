import { expect, test } from '@rstest/core'
import { fakeRequest, fakeResponse, fakeStreamingRequest } from '@seaveyon/dsh-plugin-testkit'
import {
  type ClientKeyOptions,
  clientKey,
  isDocumentNavigation,
  isFormPost,
  readBody,
  SECURITY_HEADERS,
  sendHtml,
  sendJsonError,
  sendRedirect,
} from '../../src/http.js'

test('every helper attaches the full security header set', () => {
  const send = [
    (res: ReturnType<typeof fakeResponse>) => sendHtml(res, 200, '<p>hi</p>'),
    (res: ReturnType<typeof fakeResponse>) => sendJsonError(res, 401, 'unauthenticated'),
    (res: ReturnType<typeof fakeResponse>) => sendRedirect(res, 302, '/login'),
  ]
  for (const emit of send) {
    const res = fakeResponse()
    emit(res)
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers?.[header], `missing ${header}`).toBe(value)
    }
  }
})

test('the CSP forbids scripts, framing, and off-origin form posts', () => {
  const csp = SECURITY_HEADERS['content-security-policy']
  expect(csp).toMatch(/default-src 'none'/)
  expect(csp).toMatch(/frame-ancestors 'none'/)
  expect(csp).toMatch(/form-action 'self'/)
  expect(csp).toMatch(/base-uri 'none'/)
  // Inline styles are the one allowance: the page ships its stylesheet inline
  // rather than fetching an asset from behind the gate it guards.
  expect(csp).toMatch(/style-src 'unsafe-inline'/)
  expect(/script-src/.test(csp), 'default-src none already covers scripts').toBe(false)
})

test('responses are never cached', () => {
  const res = fakeResponse()
  sendHtml(res, 200, 'x')
  expect(res.headers?.['cache-control']).toBe('no-store')
  expect(res.headers?.pragma).toBe('no-cache')
})

test('sendHtml and sendJsonError set their content types and bodies', () => {
  const html = fakeResponse()
  sendHtml(html, 200, '<p>hi</p>')
  expect(html.status).toBe(200)
  expect(html.headers?.['content-type']).toBe('text/html; charset=utf-8')
  expect(html.body).toBe('<p>hi</p>')

  const json = fakeResponse()
  sendJsonError(json, 429, 'too_many_requests', { 'retry-after': '5' })
  expect(json.status).toBe(429)
  expect(json.headers?.['content-type']).toBe('application/json; charset=utf-8')
  expect(json.headers?.['retry-after']).toBe('5')
  expect(JSON.parse(json.body ?? '')).toEqual({ error: 'too_many_requests' })
})

test('sendRedirect sets Location and an empty body', () => {
  const res = fakeResponse()
  sendRedirect(res, 303, '/', { 'set-cookie': 'a=b' })
  expect(res.status).toBe(303)
  expect(res.headers?.location).toBe('/')
  expect(res.headers?.['set-cookie']).toBe('a=b')
  expect(res.body).toBe('')
})

test('extra headers may override a default but cannot drop the set', () => {
  const res = fakeResponse()
  sendHtml(res, 200, 'x', { 'cache-control': 'no-store, max-age=0' })
  expect(res.headers?.['cache-control']).toBe('no-store, max-age=0')
  expect(res.headers?.['x-frame-options']).toBe('DENY')
})

test('fetch metadata identifies a document navigation', () => {
  const nav = fakeRequest({
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' },
  })
  expect(isDocumentNavigation(nav)).toBe(true)
})

test('fetch metadata overrides an Accept header that claims HTML', () => {
  // The case this exists for: a same-origin `fetch('/api/...')` sending
  // `Accept: text/html`. A 302 would hand the SPA a login document where it
  // expected JSON, which surfaces as a parse error rather than a sign-in prompt.
  const apiFetch = fakeRequest({
    headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'text/html,*/*' },
  })
  expect(isDocumentNavigation(apiFetch)).toBe(false)

  const sameOrigin = fakeRequest({
    headers: { 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty' },
  })
  expect(isDocumentNavigation(sameOrigin)).toBe(false)
})

test('a partial fetch-metadata set is still authoritative', () => {
  const destOnly = fakeRequest({ headers: { 'sec-fetch-dest': 'image', accept: 'text/html' } })
  expect(isDocumentNavigation(destOnly)).toBe(false)
})

test('Accept is the fallback for clients without fetch metadata', () => {
  expect(isDocumentNavigation(fakeRequest({ headers: { accept: 'text/html' } }))).toBe(true)
  expect(isDocumentNavigation(fakeRequest({ headers: { accept: 'application/json' } }))).toBe(false)
  expect(isDocumentNavigation(fakeRequest({ headers: {} }))).toBe(false)
})

test('only GET and HEAD are ever treated as navigations', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const req = fakeRequest({
      method,
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    expect(isDocumentNavigation(req), method).toBe(false)
  }
  const head = fakeRequest({ method: 'HEAD', headers: { accept: 'text/html' } })
  expect(isDocumentNavigation(head)).toBe(true)
})

/** Bucket widths that keep each address distinct, so these tests read plainly. */
const EXACT = { ipv4PrefixBits: 32, ipv6PrefixBits: 128 } as const

test('clientKey uses the socket address and ignores a forged header by default', () => {
  const req = fakeRequest({
    headers: { 'x-forwarded-for': '1.1.1.1' },
    remoteAddress: '10.0.0.7',
  })
  const options: ClientKeyOptions = {
    trustProxy: false,
    clientIpHeader: 'x-forwarded-for',
    ...EXACT,
  }
  expect(clientKey(req, options)).toBe('10.0.0.7/32')
})

test('clientKey takes the last forwarded hop when the proxy is trusted', () => {
  // The proxy appends the peer it actually saw, so only the last entry is
  // vouched for; trusting the first would let a client pick its own identity.
  const req = fakeRequest({
    headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.5' },
    remoteAddress: '10.0.0.7',
  })
  const options: ClientKeyOptions = {
    trustProxy: true,
    clientIpHeader: 'x-forwarded-for',
    ...EXACT,
  }
  expect(clientKey(req, options)).toBe('203.0.113.5/32')
})

test('clientKey falls back to the socket when the trusted header is missing or blank', () => {
  const options: ClientKeyOptions = {
    trustProxy: true,
    clientIpHeader: 'x-forwarded-for',
    ...EXACT,
  }
  expect(clientKey(fakeRequest({ remoteAddress: '10.0.0.7' }), options)).toBe('10.0.0.7/32')
  const blank = fakeRequest({
    headers: { 'x-forwarded-for': '  ,  ' },
    remoteAddress: '10.0.0.7',
  })
  expect(clientKey(blank, options)).toBe('10.0.0.7/32')
})

test('clientKey handles a repeated header and a socket with no address', () => {
  const options: ClientKeyOptions = {
    trustProxy: true,
    clientIpHeader: 'x-forwarded-for',
    ...EXACT,
  }
  const repeated = fakeRequest({ headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] } })
  expect(clientKey(repeated, options)).toBe('1.1.1.1/32')
  // A request whose peer has already gone still has to produce a rate-limit key
  // rather than throw on the way to the 401.
  const noSocket = fakeRequest({ remoteAddress: null })
  expect(
    clientKey(noSocket, { trustProxy: false, clientIpHeader: 'x-forwarded-for', ...EXACT }),
  ).toBe('unknown')
})

test('clientKey collapses an IPv6 network into one bucket', () => {
  const options: ClientKeyOptions = {
    trustProxy: false,
    clientIpHeader: 'x-forwarded-for',
    ipv4PrefixBits: 32,
    ipv6PrefixBits: 64,
  }
  // Two addresses a single customer allocation holds simultaneously. Counting
  // them apart is what gives one attacker an unbounded supply of allowances.
  const first = fakeRequest({ remoteAddress: '2001:db8:1:2:3:4:5:6' })
  const second = fakeRequest({ remoteAddress: '2001:db8:1:2:ffff:ffff:ffff:ffff' })
  expect(clientKey(first, options)).toBe(clientKey(second, options))

  const elsewhere = fakeRequest({ remoteAddress: '2001:db8:1:3::1' })
  expect(clientKey(elsewhere, options)).not.toBe(clientKey(first, options))
})

test('clientKey gives every forged forwarded value the same bucket', () => {
  const options: ClientKeyOptions = {
    trustProxy: true,
    clientIpHeader: 'x-forwarded-for',
    ...EXACT,
  }
  // Under trustProxy the "address" is attacker-chosen text of arbitrary length.
  // Distinct garbage must not buy distinct allowances.
  const keys = ['not-an-ip', 'x'.repeat(4096), '999.1.1.1', '<script>'].map((value) =>
    clientKey(fakeRequest({ headers: { 'x-forwarded-for': value } }), options),
  )
  expect(new Set(keys).size).toBe(1)
})

test('readBody returns the body when it fits', async () => {
  const req = fakeRequest({ method: 'POST', chunks: ['pass', 'word=x'] })
  expect(await readBody(req, 100)).toBe('password=x')
})

test('readBody refuses an over-cap Content-Length without collecting it', async () => {
  const stream = fakeStreamingRequest({ headers: { 'content-length': '5000' } })
  stream.push('x'.repeat(5000))
  expect(await readBody(stream.request, 100)).toBeNull()
  // Draining is intentional (it keeps HTTP framing valid), but the helper must
  // not tear down the socket before its caller can send 413.
  expect(stream.destroyed()).toBe(false)
})

test('readBody stops at the cap when Content-Length lies', async () => {
  const req = fakeRequest({
    method: 'POST',
    headers: { 'content-length': '10' },
    chunks: ['x'.repeat(50), 'x'.repeat(200)],
  })
  expect(await readBody(req, 100)).toBeNull()
})

test('readBody does not destroy an incomplete request', async () => {
  // The regression this guards: `for await` with an early `return` invokes the
  // iterator's `return()`, which destroys the stream — and destroying an
  // IncomingMessage mid-body tears down its socket, so the 413 the caller is
  // about to send never arrives. The stream here never ends, so any destroy
  // observed is one this code caused rather than Node's autoDestroy after end.
  const stream = fakeStreamingRequest()
  const pending = readBody(stream.request, 10)
  stream.push('x'.repeat(500))
  expect(await pending).toBeNull()
  expect(stream.destroyed(), 'destroying here would show the client a connection reset').toBe(false)
})

test('readBody stops listening once it has settled', async () => {
  const stream = fakeStreamingRequest()
  const pending = readBody(stream.request, 10)
  stream.push('x'.repeat(50))
  expect(await pending).toBeNull()
  for (const event of ['data', 'end', 'error', 'aborted']) {
    expect(stream.listenerCount(event), `${event} listener leaked`).toBe(0)
  }
})

test('readBody yields null when the client disappears mid-body', async () => {
  const stream = fakeStreamingRequest()
  const pending = readBody(stream.request, 100)
  stream.push('pass')
  // Rejecting instead would surface as an unhandled rejection inside whatever
  // dispatcher hosts the handler, and there is no socket left to answer on.
  stream.abort()
  expect(await pending).toBeNull()
})

test('readBody accepts a body exactly at the cap', async () => {
  const req = fakeRequest({ method: 'POST', chunks: ['x'.repeat(64)] })
  expect(await readBody(req, 64)).toHaveLength(64)
})

test('readBody handles an absent or unparsable Content-Length', async () => {
  const req = fakeRequest({
    method: 'POST',
    headers: { 'content-length': 'abc' },
    chunks: ['a=1'],
  })
  expect(await readBody(req, 100)).toBe('a=1')
})

test('isFormPost accepts only urlencoded bodies', () => {
  const accepted = [
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=utf-8',
    'Application/X-WWW-Form-Urlencoded',
    '  application/x-www-form-urlencoded  ',
  ]
  for (const type of accepted) {
    expect(isFormPost(fakeRequest({ headers: { 'content-type': type } })), type).toBe(true)
  }
  const refused = ['text/plain', 'application/json', 'multipart/form-data; boundary=x', '']
  for (const type of refused) {
    expect(isFormPost(fakeRequest({ headers: { 'content-type': type } })), type).toBe(false)
  }
  expect(isFormPost(fakeRequest())).toBe(false)
})
