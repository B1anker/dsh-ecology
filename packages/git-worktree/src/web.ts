import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

export interface WebServerService {
  register(route: { kind: 'exact'; path: string; handler: RouteHandler }): () => void
}

/**
 * The host side of `@deepseek-ai/dsh-client-connection`, as this plugin reads
 * it: `requestRejection` applies the configured Host/Origin fence and browser
 * authentication and answers with the status to reject with, or `undefined`
 * when the request may proceed. Declared by hand for the same reason as
 * `WebServerService` — the host packages are peers this package never
 * imports; `scripts/check-host-contract.mjs` re-verifies the member.
 */
export interface ConnectionService {
  requestRejection(request: IncomingMessage): number | undefined
}

/**
 * A view of the registry that puts every route behind the host's fence.
 *
 * Every management route here runs Git against a caller-supplied path
 * (`create` makes branches and directories, `remove` deletes both), so none
 * may answer a request the host would not let reach its own `/api`:
 * same-origin only, and authenticated when the host requires a browser
 * session. Registering through this view instead of the raw service means a
 * route cannot be added unfenced by forgetting a wrapper.
 */
export function fenceRoutes(
  server: WebServerService,
  connection: ConnectionService,
): WebServerService {
  return {
    register(route) {
      return server.register({ ...route, handler: fenced(connection, route.handler) })
    },
  }
}

/** One handler behind the fence; see {@link fenceRoutes}. */
export function fenced(connection: ConnectionService, handler: RouteHandler): RouteHandler {
  return async (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return
    }
    await handler(req, res)
  }
}

const BODY_TIMEOUT_MS = 3_000

export async function readJsonBody(
  req: IncomingMessage,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const timeoutMs = options?.timeoutMs ?? BODY_TIMEOUT_MS
  const parts: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      cleanup()
      req.resume()
      reject(new Error('request_body_timeout'))
    }, timeoutMs)
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAbort)
    }
    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > 16_384) {
        cleanup()
        req.resume()
        reject(new Error('request_too_large'))
        return
      }
      parts.push(buf)
    }
    const onEnd = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      reject(new Error('request_aborted'))
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAbort)
  })
  const raw = Buffer.concat(parts).toString('utf8')
  if (raw.length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid_json_body')
  return parsed as Record<string, unknown>
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/** Bound an async route so a stuck handler cannot hold the connection forever. */
export async function withHandlerTimeout(
  res: ServerResponse,
  timeoutMs: number,
  run: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('handler_timeout')), timeoutMs)
      }),
    ])
  } catch (error) {
    if (!res.headersSent) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, message === 'handler_timeout' ? 504 : 400, { error: message })
    } else {
      res.destroy()
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
