import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
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
