import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { deploymentRoot } from './deployment.js'
export async function deploymentService(ctx: CliContext, action: 'status' | 'start' | 'stop') {
  const record = await readFile(join(deploymentRoot(ctx), 'service.json'), 'utf8')
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === 'ENOENT') return null
      throw e
    })
  if (record) {
    if (
      !Number.isInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(record.token)
    )
      throw new UsageError('守护控制记录损坏')
    try {
      const response = await fetch(
        `http://127.0.0.1:${record.port}/${action === 'stop' ? 'stop' : 'status'}`,
        {
          method: action === 'stop' ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${record.token}` },
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        },
      )
      if (!response.ok) throw new UsageError('守护控制认证失败')
      return await response.json()
    } catch (e) {
      if (e instanceof UsageError) throw e
      if (action === 'stop') throw new UsageError('守护进程无法连接；请先核对进程与失效锁')
    }
  }
  if (action !== 'start') {
    const lastError = await readFile(join(deploymentRoot(ctx), 'worker-error.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    return { running: false, error: lastError?.error ?? null }
  }
  const worker = fileURLToPath(new URL('./deployment-worker.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = fork(
      worker,
      [ctx.home, ctx.profileName, ctx.breakStaleLock ? 'break-stale' : 'keep-locks'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: ctx.experimentEnv ?? ctx.env,
        execArgv: [],
      },
    )
    const timer = setTimeout(() => {
      reject(new UsageError('守护启动状态未确认，请刷新后检查'))
      if (child.connected) child.disconnect()
      child.unref()
    }, 15000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new UsageError(`守护进程启动退出 ${code}`))
    })
    child.once('message', (message) => {
      clearTimeout(timer)
      resolve(message)
      if (child.connected) child.disconnect()
      child.unref()
    })
  })
}
