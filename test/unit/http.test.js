import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  clientKey,
  isDocumentNavigation,
  isFormPost,
  readBody,
  SECURITY_HEADERS,
  sendHtml,
  sendJsonError,
  sendRedirect,
} from '../../src/http.js'
import { fakeRequest, fakeResponse } from '../helpers/fake-http.js'

test('every helper attaches the full security header set', () => {
  const send = [
    (res) => sendHtml(res, 200, '<p>hi</p>'),
    (res) => sendJsonError(res, 401, 'unauthenticated'),
    (res) => sendRedirect(res, 302, '/login'),
  ]
  for (const emit of send) {
    const res = fakeResponse()
    emit(res)
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[header], value, `missing ${header}`)
    }
  }
})

test('the CSP forbids scripts, framing, and off-origin form posts', () => {
  const csp = SECURITY_HEADERS['content-security-policy']
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /form-action 'self'/)
  assert.match(csp, /base-uri 'none'/)
  // Inline styles are the one allowance: the page ships its stylesheet inline
  // rather than fetching an asset from behind the gate it guards.
  assert.match(csp, /style-src 'unsafe-inline'/)
  assert.ok(!/script-src/.test(csp), 'default-src none already covers scripts')
})

test('responses are never cached', () => {
  const res = fakeResponse()
  sendHtml(res, 200, 'x')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers.pragma, 'no-cache')
})

test('sendHtml and sendJsonError set their content types and bodies', () => {
  const html = fakeResponse()
  sendHtml(html, 200, '<p>hi</p>')
  assert.equal(html.status, 200)
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(html.body, '<p>hi</p>')

  const json = fakeResponse()
  sendJsonError(json, 429, 'too_many_requests', { 'retry-after': '5' })
  assert.equal(json.status, 429)
  assert.equal(json.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(json.headers['retry-after'], '5')
  assert.deepEqual(JSON.parse(json.body), { error: 'too_many_requests' })
})

test('sendRedirect sets Location and an empty body', () => {
  const res = fakeResponse()
  sendRedirect(res, 303, '/', { 'set-cookie': 'a=b' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.location, '/')
  assert.equal(res.headers['set-cookie'], 'a=b')
  assert.equal(res.body, '')
})

test('extra headers may override a default but cannot drop the set', () => {
  const res = fakeResponse()
  sendHtml(res, 200, 'x', { 'cache-control': 'no-store, max-age=0' })
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0')
  assert.equal(res.headers['x-frame-options'], 'DENY')
})

test('fetch metadata identifies a document navigation', () => {
  const nav = fakeRequest({
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' },
  })
  assert.equal(isDocumentNavigation(nav), true)
})

test('fetch metadata overrides an Accept header that claims HTML', () => {
  // The case this exists for: a same-origin `fetch('/api/...')` sending
  // `Accept: text/html`. A 302 would hand the SPA a login document where it
  // expected JSON, which surfaces as a parse error rather than a sign-in prompt.
  const apiFetch = fakeRequest({
    headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'text/html,*/*' },
  })
  assert.equal(isDocumentNavigation(apiFetch), false)

  const sameOrigin = fakeRequest({
    headers: { 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty' },
  })
  assert.equal(isDocumentNavigation(sameOrigin), false)
})

test('a partial fetch-metadata set is still authoritative', () => {
  const destOnly = fakeRequest({ headers: { 'sec-fetch-dest': 'image', accept: 'text/html' } })
  assert.equal(isDocumentNavigation(destOnly), false)
})

test('Accept is the fallback for clients without fetch metadata', () => {
  assert.equal(isDocumentNavigation(fakeRequest({ headers: { accept: 'text/html' } })), true)
  assert.equal(isDocumentNavigation(fakeRequest({ headers: { accept: 'application/json' } })), false)
  assert.equal(isDocumentNavigation(fakeRequest({ headers: {} })), false)
})

test('only GET and HEAD are ever treated as navigations', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const req = fakeRequest({
      method,
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    })
    assert.equal(isDocumentNavigation(req), false, method)
  }
  assert.equal(isDocumentNavigation(fakeRequest({ method: 'HEAD', headers: { accept: 'text/html' } })), true)
})

test('clientKey uses the socket address and ignores a forged header by default', () => {
  const req = fakeRequest({
    headers: { 'x-forwarded-for': '1.1.1.1' },
    remoteAddress: '10.0.0.7',
  })
  const options = { trustProxy: false, clientIpHeader: 'x-forwarded-for' }
  assert.equal(clientKey(req, options), '10.0.0.7')
})

test('clientKey takes the last forwarded hop when the proxy is trusted', () => {
  // The proxy appends the peer it actually saw, so only the last entry is
  // vouched for; trusting the first would let a client pick its own identity.
  const req = fakeRequest({
    headers: { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.5' },
    remoteAddress: '10.0.0.7',
  })
  const options = { trustProxy: true, clientIpHeader: 'x-forwarded-for' }
  assert.equal(clientKey(req, options), '203.0.113.5')
})

test('clientKey falls back to the socket when the trusted header is missing or blank', () => {
  const options = { trustProxy: true, clientIpHeader: 'x-forwarded-for' }
  assert.equal(clientKey(fakeRequest({ remoteAddress: '10.0.0.7' }), options), '10.0.0.7')
  assert.equal(
    clientKey(fakeRequest({ headers: { 'x-forwarded-for': '  ,  ' }, remoteAddress: '10.0.0.7' }), options),
    '10.0.0.7',
  )
})

test('clientKey handles a repeated header and a socket with no address', () => {
  const options = { trustProxy: true, clientIpHeader: 'x-forwarded-for' }
  const repeated = fakeRequest({ headers: { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] } })
  assert.equal(clientKey(repeated, options), '1.1.1.1')
  const noSocket = fakeRequest()
  noSocket.socket = undefined
  assert.equal(clientKey(noSocket, { trustProxy: false, clientIpHeader: 'x-forwarded-for' }), 'unknown')
})

test('readBody returns the body when it fits', async () => {
  const req = fakeRequest({ method: 'POST', chunks: ['pass', 'word=x'] })
  assert.equal(await readBody(req, 100), 'password=x')
})

test('readBody refuses an over-cap Content-Length without collecting it', async () => {
  const req = fakeRequest({
    method: 'POST',
    headers: { 'content-length': '5000' },
    chunks: ['x'.repeat(5000)],
  })
  let destroyed = false
  const originalDestroy = req.destroy.bind(req)
  req.destroy = (...args) => {
    destroyed = true
    return originalDestroy(...args)
  }
  assert.equal(await readBody(req, 100), null)
  // Draining is intentional (it keeps HTTP framing valid), but the helper must
  // not tear down the socket before its caller can send 413.
  assert.equal(destroyed, false)
})

test('readBody stops at the cap when Content-Length lies', async () => {
  const req = fakeRequest({
    method: 'POST',
    headers: { 'content-length': '10' },
    chunks: ['x'.repeat(50), 'x'.repeat(200)],
  })
  assert.equal(await readBody(req, 100), null)
})

test('readBody does not destroy an incomplete request', async () => {
  // The regression this guards: `for await` with an early `return` invokes the
  // iterator's `return()`, which destroys the stream — and destroying an
  // IncomingMessage mid-body tears down its socket, so the 413 the caller is
  // about to send never arrives. The stream here never ends, so any destroy
  // observed is one this code caused rather than Node's autoDestroy after end.
  const req = new PassThrough()
  req.method = 'POST'
  req.headers = {}
  req.socket = { remoteAddress: '10.0.0.1' }
  let destroyed = false
  req.destroy = () => { destroyed = true }

  const pending = readBody(req, 10)
  req.write('x'.repeat(500))
  assert.equal(await pending, null)
  assert.equal(destroyed, false, 'destroying here would show the client a connection reset')
})

test('readBody stops listening once it has settled', async () => {
  const req = new PassThrough()
  req.method = 'POST'
  req.headers = {}
  const pending = readBody(req, 10)
  req.write('x'.repeat(50))
  assert.equal(await pending, null)
  for (const event of ['data', 'end', 'error', 'aborted']) {
    assert.equal(req.listenerCount(event), 0, `${event} listener leaked`)
  }
})

test('readBody yields null when the client disappears mid-body', async () => {
  const req = new PassThrough()
  req.method = 'POST'
  req.headers = {}
  const pending = readBody(req, 100)
  req.write('pass')
  // Rejecting instead would surface as an unhandled rejection inside whatever
  // dispatcher hosts the handler, and there is no socket left to answer on.
  req.emit('aborted')
  assert.equal(await pending, null)
})

test('readBody accepts a body exactly at the cap', async () => {
  const req = fakeRequest({ method: 'POST', chunks: ['x'.repeat(64)] })
  assert.equal((await readBody(req, 64)).length, 64)
})

test('readBody handles an absent or unparsable Content-Length', async () => {
  const req = fakeRequest({ method: 'POST', headers: { 'content-length': 'abc' }, chunks: ['a=1'] })
  assert.equal(await readBody(req, 100), 'a=1')
})

test('isFormPost accepts only urlencoded bodies', () => {
  const accepted = [
    'application/x-www-form-urlencoded',
    'application/x-www-form-urlencoded; charset=utf-8',
    'Application/X-WWW-Form-Urlencoded',
    '  application/x-www-form-urlencoded  ',
  ]
  for (const type of accepted) {
    assert.equal(isFormPost(fakeRequest({ headers: { 'content-type': type } })), true, type)
  }
  const refused = ['text/plain', 'application/json', 'multipart/form-data; boundary=x', '']
  for (const type of refused) {
    assert.equal(isFormPost(fakeRequest({ headers: { 'content-type': type } })), false, type)
  }
  assert.equal(isFormPost(fakeRequest()), false)
})
