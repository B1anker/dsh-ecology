/**
 * The loopback control endpoint a detached worker exposes to the CLI that
 * started it.
 *
 * Two workers run detached from any terminal — the lab supervisor
 * (`lab/service-worker.ts`) holding a mirror's DSH open, the deployment
 * watchdog (`workflows/deployment-worker.ts`) rotating slots — and each
 * needs the same two verbs from the outside: "how are you" and "stop". Both
 * used to carry their own copy of this server inline in a top-level script,
 * where nothing could exercise it short of forking the worker. This is the
 * one copy: a bearer token read on every request (the lab worker mints its
 * token only after DSH is up, so a request that arrives first is refused,
 * not crashed on), `GET /status`, `POST /stop`, and nothing else.
 *
 * @module control-server
 */

import { createServer, type Server } from 'node:http'

export interface ControlEndpoint {
  /** The bearer token clients must present; undefined refuses everything. */
  token(): string | undefined
  /** Body of `GET /status`; also of `POST /stop` when `stop` returns nothing. */
  status(): unknown
  /** Called on `POST /stop`; may return the response body. A throw is a 500. */
  stop(): unknown
}

/** Build the server; the caller listens through {@link listenLoopback}. */
export function createControlServer(endpoint: ControlEndpoint): Server {
  return createServer((request, response) => {
    const token = endpoint.token()
    if (token === undefined || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403)
      response.end()
      return
    }
    const respond = (body: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && request.url === '/status') {
      respond(endpoint.status())
      return
    }
    if (request.method === 'POST' && request.url === '/stop') {
      Promise.resolve()
        .then(() => endpoint.stop())
        .then(
          (body) => respond(body ?? endpoint.status()),
          () => {
            response.writeHead(500)
            response.end()
          },
        )
      return
    }
    response.writeHead(404)
    response.end()
  })
}

/** Listen on an ephemeral loopback port and resolve with that port. */
export function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no control port'))
        return
      }
      resolve(address.port)
    })
  })
}
