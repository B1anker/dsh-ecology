/**
 * A double for the host side of `@deepseek-ai/dsh-client-connection`.
 *
 * Route owners that expose an authenticated management API read one member
 * of the `connection` service: `requestRejection(req)`, which applies the
 * configured Host/Origin fence and browser authentication and answers with a
 * status code to reject with, or `undefined` when the route may proceed. A
 * plugin that forgets to consult it serves its API to anyone on the network,
 * so tests need a way to make the fence say "no" on demand.
 *
 * ```ts
 * const connection = createMockConnection()
 * const ctx = createMockContext({ webServer: web.service, connection })
 * connection.rejectWhen((req) => (req.headers.cookie === undefined ? 401 : undefined))
 * ```
 *
 * Nothing here is for production use.
 *
 * @module @seaveyon/dsh-plugin-testkit/connection
 */

import type { IncomingMessage } from 'node:http'

/** The shape of a request the fence inspects: headers are all it reads. */
export type ConnectionTrustRequest = Pick<IncomingMessage, 'headers'> &
  Partial<Pick<IncomingMessage, 'url' | 'method' | 'socket'>>

/** A status code to reject with, or `undefined` to let the request through. */
export type ConnectionRejection = number | undefined

/** The `connection` service double, as a route owner reads it. */
export interface MockConnection {
  requestRejection(request: ConnectionTrustRequest): ConnectionRejection
  /**
   * Install the fence policy. The default accepts everything; a policy
   * returns the status to reject with, or `undefined` to accept.
   */
  rejectWhen(policy: (request: ConnectionTrustRequest) => ConnectionRejection): void
  /** Every request the fence was asked about, with its answer, in order. */
  readonly consulted: readonly { request: ConnectionTrustRequest; rejection: ConnectionRejection }[]
}

/**
 * Create the connection double.
 *
 * @param policy - initial fence policy; defaults to accepting every request.
 */
export function createMockConnection(
  policy: (request: ConnectionTrustRequest) => ConnectionRejection = () => undefined,
): MockConnection {
  let current = policy
  const consulted: { request: ConnectionTrustRequest; rejection: ConnectionRejection }[] = []
  return {
    consulted,
    requestRejection(request) {
      const rejection = current(request)
      consulted.push({ request, rejection })
      return rejection
    },
    rejectWhen(next) {
      current = next
    },
  }
}
