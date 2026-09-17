/**
 * The authenticated management API — `/api/world-line` — as a service.
 *
 * One exact route that answers reads (`GET`), the jobs event stream
 * (`GET ?stream=jobs`), artifact downloads (`GET ?artifact=`) and actions
 * (`POST`, same-origin JSON). Every request is first put to the host's
 * `connection.requestRejection`, which is DSH browser authentication; writes
 * additionally require an explicit same-origin JSON request. The handler body
 * is what `apply` used to close over inline; only its collaborators are now
 * injected.
 *
 * @module @seaveyon/dsh-world-line/web/api
 */

import { inject } from '@seaveyon/dsh-di'
import { UsageError } from '../domain/errors.js'
import { redactText } from '../domain/redaction.js'
import { snapshotsDir } from '../fs/paths.js'
import { readArtifact } from '../lab/artifacts.js'
import { journalPath } from '../lab/journal.js'
import { labRoot } from '../lab/layout.js'
import { reportContext } from './extended-actions.js'
import {
  type ConnectionService,
  type Handler,
  IConnection,
  IContextFactory,
  ILocation,
  type IManagementApi,
  IOperateDeps,
  IReadCache,
  IWebServer,
  type WebServerService,
  type WorldLineLocation,
} from './identifiers.js'
import { jobEvents } from './job-events.js'
import { openJobStream } from './job-stream.js'
import { subscribeJobs } from './jobs.js'
import { type OperateDeps, operate, worldLines } from './operations.js'
import type { ReadCache } from './read-cache.js'
import { revisionResponse } from './revisions.js'

export const API_PATH = '/api/world-line'

@inject(IWebServer, IConnection, ILocation, IContextFactory, IReadCache, IOperateDeps)
export class ManagementApi implements IManagementApi {
  declare readonly _serviceBrand: undefined
  readonly path = API_PATH
  readonly handler: Handler

  constructor(
    private readonly server: WebServerService,
    connection: ConnectionService,
    location: WorldLineLocation,
    contextFactory: IContextFactory,
    reads: ReadCache,
    deps: OperateDeps,
  ) {
    const { currentId } = location
    const context = () => contextFactory.create()
    this.handler = async (req, res) => {
      const send = (status: number, data: unknown) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end(JSON.stringify(data))
      }
      const rejection = connection.requestRejection(req)
      if (rejection) {
        send(rejection, { error: '请重新打开 DSH 登录入口' })
        return
      }
      try {
        if (
          req.method === 'GET' &&
          new URL(req.url ?? '/', 'http://localhost').searchParams.get('stream') === 'jobs'
        ) {
          const ctx = await context()
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          })
          let last =
            typeof req.headers['last-event-id'] === 'string'
              ? req.headers['last-event-id']
              : undefined
          openJobStream(
            res,
            () => {
              const events = jobEvents(ctx, last)
              if (events.length) last = events.at(-1)!.id
              return events
            },
            subscribeJobs,
            () => !!connection.requestRejection(req),
          )
          return
        }
        if (
          req.method === 'GET' &&
          new URL(req.url ?? '/', 'http://localhost').searchParams.has('artifact')
        ) {
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams
          const ctx = await context()
          const labId = params.get('lab') ?? ''
          await reportContext(ctx, labId)
          const name = params.get('file') ?? ''
          const bytes = await readArtifact(ctx.home, labId, params.get('artifact') ?? '', name)
          res.writeHead(200, {
            'content-type': name === 'failure.png' ? 'image/png' : 'application/zip',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-disposition': `attachment; filename="${name}"`,
            'referrer-policy': 'no-referrer',
          })
          res.end(bytes)
          return
        }
        if (req.method === 'GET') {
          const ctx = await context()
          const result = await reads.read(
            `${ctx.home}:${ctx.profileName}:${currentId}:world-lines`,
            [labRoot(ctx.home), journalPath(ctx.home), snapshotsDir(ctx.home)],
            () => worldLines(ctx, currentId),
            1500,
          )
          const since = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since')
          send(200, revisionResponse(`${ctx.home}:${ctx.profileName}:${currentId}`, result, since))
          return
        }
        if (req.method !== 'POST') {
          send(405, { error: 'Method not allowed' })
          return
        }
        // Require an explicit same-origin JSON request in addition to native authentication.
        if (
          !req.headers.origin ||
          new URL(req.headers.origin).host !== req.headers.host ||
          req.headers['content-type'] !== 'application/json'
        ) {
          send(403, { error: 'Same-origin JSON request required' })
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          length += bytes.length
          if (length > 34 * 1024 * 1024) {
            send(413, { error: 'Request too large' })
            return
          }
          chunks.push(bytes)
        }
        const raw = Buffer.concat(chunks, length).toString('utf8')
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch (error) {
          if (Buffer.byteLength(raw) > 8192) {
            send(413, { error: 'Request too large' })
            return
          }
          throw error
        }
        if (
          Buffer.byteLength(raw) > 8192 &&
          !['lab-config-apply', 'environment-import'].includes(
            (body as { action?: string })?.action ?? '',
          )
        ) {
          send(413, { error: 'Request too large' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new UsageError('无效请求')
        send(
          200,
          await operate(
            { ...(await context()), authenticatedWebAction: true },
            body as Record<string, unknown>,
            currentId,
            deps,
          ),
        )
      } catch (error) {
        send(error instanceof UsageError ? 400 : 500, {
          error: redactText(error instanceof Error ? error.message : '操作失败'),
        })
      }
    }
  }

  register(): () => void {
    return this.server.register({ kind: 'exact', path: this.path, handler: this.handler })
  }
}
