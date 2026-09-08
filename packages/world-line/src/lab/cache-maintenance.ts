import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runLabStart } from '../commands/lab-service.js'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { isProcessAlive } from '../fs/lock.js'
import { withOperations } from '../fs/operation.js'
import { requirePnpm } from './gate.js'
import { listLabs } from './layout.js'
import { readLabManifest } from './manifest.js'
import { runCaptured } from './runner.js'
import { readService } from './service.js'

const owned = new AsyncLocalStorage<Set<string>>()
const root = (home: string) => join(home, 'world-line', 'cache')
export async function withPackageCache<T>(home: string, run: () => Promise<T>): Promise<T> {
  const prior = owned.getStore() ?? new Set<string>()
  if (prior.has(home)) return run()
  const lease = join(root(home), 'leases', `${randomUUID()}.json`)
  await withOperations([home], 'package-cache', async () => {
    await mkdir(join(root(home), 'leases'), { recursive: true, mode: 0o700 })
    await writeFileAtomic(
      lease,
      JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date().toISOString() }),
    )
  })
  try {
    return await owned.run(new Set([...prior, home]), run)
  } finally {
    await rm(lease, { force: true })
  }
}
export async function prunePackageCache(ctx: CliContext, runtimeStopped = false) {
  return withOperations([ctx.home], 'package-cache', async () => {
    const leases = await readdir(join(root(ctx.home), 'leases')).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    for (const file of leases) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) throw new UsageError('未知缓存租约，停止清理')
      const path = join(root(ctx.home), 'leases', file),
        lease = JSON.parse(await readFile(path, 'utf8'))
      if (
        lease.version !== 1 ||
        !Number.isInteger(lease.pid) ||
        isProcessAlive(lease.pid) ||
        !runtimeStopped
      )
        throw new UsageError('缓存仍有安装/验证租约；中断租约需确认相关进程已停止')
      await rm(path)
    }
    for (const id of await listLabs(ctx.home)) {
      const lab = await readLabManifest(ctx.home, id),
        service = await readService(ctx.home, id)
      if (lab.state === 'applying' || service?.state === 'running')
        throw new UsageError('请先停止运行实例与验证任务，再清理共享缓存')
    }
    const result = await runCaptured(
      requirePnpm(ctx.env).path,
      ['store', 'prune', '--store-dir', join(root(ctx.home), 'pnpm-store')],
      { cwd: ctx.home, env: ctx.env, timeoutMs: 180000 },
    )
    if (result.exitCode !== 0 || result.spawnError || result.timedOut)
      throw new UsageError('pnpm 缓存清理未完成')
    return { ok: true, note: '由 pnpm 清理未使用下载缓存；实验与正式环境文件保持独立。' }
  })
}
export async function migratePackageCache(ctx: CliContext, id: string) {
  const lab = await readLabManifest(ctx.home, id)
  if (lab.source.profileName !== ctx.profileName) throw new UsageError('实验不属于此 profile')
  if (lab.packageStore === 'shared-copy-v1') return { ok: true, id, alreadyShared: true }
  // A successor avoids re-pointing a legacy pnpm virtual store in place. Old data stays recoverable.
  const result = await runLabStart(ctx, {
    new: true,
    from: id,
    alias: `迁移-${id.slice(-8)}-${Date.now().toString(36)}`,
  })
  return {
    ...result,
    previousId: id,
    note: '已复制到共享缓存的新实例。检查新实例后，可从画布停止并删除旧实例。',
  }
}
