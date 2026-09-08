import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { redactData } from '../domain/redact-data.js'
import { redactText } from '../domain/redaction.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { sha256Hex } from '../fs/hash.js'
import { acquireLock } from '../fs/lock.js'

const active = new Map<string, { digest: string; promise: Promise<unknown> }>()
export async function idempotent(
  ctx: CliContext,
  body: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const id = body.requestId
  if (id === undefined) return run()
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(id))
    throw new UsageError('无效请求编号')
  const directory = join(ctx.home, 'world-line', 'requests')
  const key = sha256Hex(`${ctx.profileName}\0${id}`)
  const file = join(directory, `${key}.json`)
  const digest = sha256Hex(
    JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)))),
  )
  const existing = active.get(file)
  if (existing) {
    if (existing.digest !== digest) throw new UsageError('请求编号已用于其他操作')
    return existing.promise
  }
  const promise = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lock = await acquireLock({
      lockPath: `${file}.lock`,
      purpose: 'idempotent request',
      breakStale: ctx.breakStaleLock,
    })
    try {
      const prior = await readFile(file, 'utf8')
        .then(JSON.parse)
        .catch((e) => {
          if (e.code === 'ENOENT') return null
          throw e
        })
      if (prior) {
        if (prior.version !== 1 || prior.digest !== digest)
          throw new UsageError('请求编号冲突或记录损坏')
        if (prior.state === 'done') return prior.result
        if (prior.state === 'error') throw new UsageError(prior.error)
        throw new UsageError('此请求曾被接收但结果未确认，请先检查任务台和恢复记录，勿重复提交')
      }
      const base = { version: 1, digest, createdAt: ctx.now().toISOString() }
      await writeFileAtomic(file, JSON.stringify({ ...base, state: 'pending' }))
      try {
        const result = await run()
        await writeFileAtomic(
          file,
          JSON.stringify({ ...base, state: 'done', result: redactData(result ?? null) }),
        )
        return result
      } catch (error) {
        await writeFileAtomic(
          file,
          JSON.stringify({
            ...base,
            state: 'error',
            error: redactText(error instanceof Error ? error.message : String(error)),
          }),
        )
        throw error
      }
    } finally {
      await lock.release()
    }
  })()
  active.set(file, { digest, promise })
  try {
    return await promise
  } finally {
    active.delete(file)
  }
}
