import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  for await (const part of req) parts.push(Buffer.from(part))
  const raw = Buffer.concat(parts).toString('utf8')
  if (raw.length > 16_384) throw new Error('request_too_large')
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid_json_body')
  return parsed as Record<string, unknown>
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}
