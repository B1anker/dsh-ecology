/**
 * `deploymentService`, the CLI's side of the deployment watchdog's control
 * endpoint: how it reads `service.json`, what it does with a live worker, a
 * dead one, and a record it cannot trust. The worker is stood in for by the
 * same control server the real one runs (control-server.ts), so the two
 * halves are checked against each other rather than against a hand-written
 * fake.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import { createControlServer, listenLoopback } from '../../src/control-server.js'
import { deploymentRoot } from '../../src/workflows/deployment.js'
import { deploymentService } from '../../src/workflows/deployment-service.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

const homes: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => destroyTempHome(home)))
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function context(): Promise<CliContext> {
  const home = await makeTempHome()
  homes.push(home)
  const ctx: CliContext = {
    home,
    profileName: 'web',
    cwd: home,
    env: {},
    json: true,
    breakStaleLock: false,
    now: () => new Date(),
  }
  await mkdir(deploymentRoot(ctx), { recursive: true })
  return ctx
}

const TOKEN = 'a'.repeat(64)

async function writeRecord(ctx: CliContext, record: unknown): Promise<void> {
  await writeFile(join(deploymentRoot(ctx), 'service.json'), JSON.stringify(record))
}

/** A worker's control endpoint, wired like deployment-worker.ts wires it. */
async function liveWorker(ctx: CliContext, token = TOKEN) {
  const controller = new AbortController()
  const status = { running: true, ready: { slot: 'slot-a', url: 'http://127.0.0.1:1', port: 1 } }
  const server = createControlServer({
    token: () => token,
    status: () => ({ ...status, error: null, stopping: controller.signal.aborted }),
    stop: () => controller.abort(),
  })
  servers.push(server)
  const port = await listenLoopback(server)
  await writeRecord(ctx, { version: 1, port, token: TOKEN, pid: process.pid })
  return { controller, port }
}

describe('deploymentService', () => {
  test('without a worker, status reports not running and the last worker error if any', async () => {
    const ctx = await context()
    expect(await deploymentService(ctx, 'status')).toEqual({ running: false, error: null })

    await writeFile(
      join(deploymentRoot(ctx), 'worker-error.json'),
      JSON.stringify({ error: 'slot boot failed twice' }),
    )
    expect(await deploymentService(ctx, 'status')).toEqual({
      running: false,
      error: 'slot boot failed twice',
    })
    // Stop with no record to dial reports the same: nothing is running.
    expect(await deploymentService(ctx, 'stop')).toEqual({
      running: false,
      error: 'slot boot failed twice',
    })
  })

  test('status and stop reach a live worker with its token', async () => {
    const ctx = await context()
    const { controller } = await liveWorker(ctx)

    const status = (await deploymentService(ctx, 'status')) as { running: boolean; ready: unknown }
    expect(status.running).toBe(true)
    expect(status.ready).toEqual({ slot: 'slot-a', url: 'http://127.0.0.1:1', port: 1 })

    const stopped = (await deploymentService(ctx, 'stop')) as { stopping: boolean }
    expect(stopped.stopping).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  test('a worker that refuses the token is reported as an authentication failure', async () => {
    const ctx = await context()
    // The record's token and the worker's disagree: the record is stale.
    await liveWorker(ctx, 'b'.repeat(64))
    await expect(deploymentService(ctx, 'status')).rejects.toThrow('守护控制认证失败')
    await expect(deploymentService(ctx, 'stop')).rejects.toThrow('守护控制认证失败')
  })

  test('a corrupt record is refused before anything is dialled', async () => {
    const ctx = await context()
    for (const record of [
      { version: 1, port: 0, token: TOKEN },
      { version: 1, port: 70000, token: TOKEN },
      { version: 1, port: 8080.5, token: TOKEN },
      { version: 1, port: 8080, token: 'short' },
      { version: 1, port: 8080, token: 'A'.repeat(64) },
      { version: 1, port: '8080', token: TOKEN },
    ]) {
      await writeRecord(ctx, record)
      await expect(deploymentService(ctx, 'status'), JSON.stringify(record)).rejects.toThrow(
        '守护控制记录损坏',
      )
    }
  })

  test('a record whose worker is gone: status falls back to the file, stop refuses', async () => {
    const ctx = await context()
    const { port } = await liveWorker(ctx)
    // Take the worker down but leave its record behind, as a crash would.
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => resolve())
    })
    await writeRecord(ctx, { version: 1, port, token: TOKEN, pid: process.pid })

    expect(await deploymentService(ctx, 'status')).toEqual({ running: false, error: null })
    await expect(deploymentService(ctx, 'stop')).rejects.toThrow('守护进程无法连接')
  })
})
