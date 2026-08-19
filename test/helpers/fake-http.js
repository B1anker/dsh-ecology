/**
 * Request and response doubles for the pure HTTP helpers.
 *
 * The integration tests drive real sockets; these exist for the cases a socket
 * makes awkward to reach — a lying `Content-Length`, a request with no
 * `sec-fetch-*` headers at all, a body delivered in chosen chunk boundaries.
 *
 * @module test/helpers/fake-http
 */

import { Readable } from 'node:stream'

/**
 * A request-like object over a fixed body.
 * @param options - `method`, `headers`, `chunks` of body data, and `remoteAddress`.
 * @returns the fake request.
 */
export function fakeRequest({ method = 'GET', headers = {}, chunks = [], remoteAddress = '10.0.0.1' } = {}) {
  const req = Readable.from(chunks.map((chunk) => Buffer.from(chunk)))
  req.method = method
  // Node lowercases incoming header names; mirror that so lookups match.
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  req.socket = { remoteAddress }
  return req
}

/**
 * A response-like object that records what was sent.
 * @returns the fake response, with `status`, `headers`, and `body`.
 */
export function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = Object.fromEntries(
        Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      )
      this.headersSent = true
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
      return this
    },
  }
}
