/**
 * Request and response doubles for pure HTTP helpers.
 *
 * Integration tests drive real sockets; these exist for the cases a socket makes
 * awkward to reach — a lying `Content-Length`, a request with no `sec-fetch-*`
 * headers at all, a body delivered in chosen chunk boundaries.
 *
 * Each factory ends in one documented cast to the Node type it stands in for.
 * The alternative — casting at every call site — would put an
 * `as unknown as IncomingMessage` beside every assertion and bury the thing each
 * test is actually about. The cast is sound in exactly one direction: the fakes
 * implement the members these helpers touch, and nothing more.
 *
 * @module @seaveyon/dsh-plugin-testkit/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'

/** What {@link fakeRequest} accepts. */
export interface FakeRequestOptions {
  method?: string
  headers?: Record<string, string | string[]>
  chunks?: (string | Buffer)[]
  /** The peer address, or `null` for a request whose socket is gone. */
  remoteAddress?: string | null
}

/**
 * A request-like object over a fixed body.
 * @param options - `method`, `headers`, `chunks` of body data, and `remoteAddress`.
 * @returns the fake request, typed as the Node request it substitutes for.
 */
export function fakeRequest({
  method = 'GET',
  headers = {},
  chunks = [],
  remoteAddress = '10.0.0.1',
}: FakeRequestOptions = {}): IncomingMessage {
  const req = Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as Readable & {
    method: string
    headers: Record<string, string | string[]>
    socket: { remoteAddress: string } | undefined
  }
  req.method = method
  // Node lowercases incoming header names; mirror that so lookups match.
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  // `null` produces a request with no socket at all rather than one with an
  // absent address: that is the shape a request has after the peer has gone, and
  // code that derives a rate-limit key from it has to survive that.
  req.socket = remoteAddress === null ? undefined : { remoteAddress }
  return req as unknown as IncomingMessage
}

/** A request whose body a test feeds in by hand, and whose teardown it watches. */
export interface StreamingRequest {
  /** The request, typed as the Node request it substitutes for. */
  request: IncomingMessage
  /** Append body bytes without ending the stream. */
  push: (data: string) => void
  /** End the body, as a complete request does. */
  end: () => void
  /** Signal that the client went away mid-body. */
  abort: () => void
  /** Whether anything called `destroy()` on the request. */
  destroyed: () => boolean
  /** Live listener count for an event, to detect a handler that was left behind. */
  listenerCount: (event: string) => number
}

/**
 * A request whose body arrives under the test's control.
 *
 * {@link fakeRequest} is enough wherever a fixed body that ends is enough. This
 * exists for the properties that are only observable mid-flight: that a reader
 * does not destroy a request it refuses (destroying an `IncomingMessage` tears
 * down its socket, so a 413 would never arrive), that it removes its listeners
 * once it has settled, and that it resolves rather than rejects when the client
 * disappears. A stream that never ends on its own is what makes those visible —
 * any destroy observed is one the code under test caused, not Node's
 * `autoDestroy` after a normal end.
 *
 * @param options - `method` and `headers`; no body is supplied up front.
 * @returns the request plus the controls above.
 */
export function fakeStreamingRequest({
  method = 'POST',
  headers = {},
  remoteAddress = '10.0.0.1',
}: Omit<FakeRequestOptions, 'chunks'> = {}): StreamingRequest {
  const stream = new PassThrough() as PassThrough & {
    method: string
    headers: Record<string, string | string[]>
    socket: { remoteAddress: string } | undefined
  }
  stream.method = method
  stream.headers = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  stream.socket = remoteAddress === null ? undefined : { remoteAddress }

  let destroyed = false
  // Replaced rather than observed: a real destroy() would end the stream and
  // make "did anything destroy this?" unanswerable afterwards.
  stream.destroy = () => {
    destroyed = true
    return stream
  }

  return {
    request: stream as unknown as IncomingMessage,
    push: (data) => {
      stream.write(data)
    },
    end: () => {
      stream.end()
    },
    abort: () => {
      stream.emit('aborted')
    },
    destroyed: () => destroyed,
    listenerCount: (event) => stream.listenerCount(event),
  }
}

/** The response surface a test reads after the code under test has written. */
export interface RecordedResponse {
  status: number | undefined
  /**
   * Headers as written, lower-cased.
   *
   * Values may be arrays because `Set-Cookie` is the one header that may
   * legally repeat, and a response that expires more than one cookie name uses
   * that.
   */
  headers: Record<string, string | string[]> | undefined
  body: string | undefined
  headersSent: boolean
}

/** A recording response that is also accepted where a real one is required. */
export type FakeResponse = RecordedResponse & ServerResponse

/**
 * A response-like object that records what was sent.
 * @returns the fake response, with `status`, `headers`, and `body`.
 */
export function fakeResponse(): FakeResponse {
  const recorder = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string | string[]> | undefined,
    body: undefined as string | undefined,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      this.status = status
      this.headers = Object.fromEntries(
        Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
      )
      this.headersSent = true
      return this
    },
    end(body?: unknown) {
      this.body = body === undefined ? '' : String(body)
      return this
    },
  }
  return recorder as unknown as FakeResponse
}
