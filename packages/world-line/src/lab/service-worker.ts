/**
 * Detached supervisor: owns DSH's pipes for its whole lifetime and answers
 * the CLI over the loopback control endpoint (control-server.ts).
 */
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { createControlServer, listenLoopback } from '../control-server.js'
import { redactText } from '../domain/redaction.js'

import { writeFileAtomic } from '../fs/atomic.js'
import { dshBootArgs } from '../host-adapters/dsh-0.1.x.js'
import { launchDsh } from './launcher.js'
import { labHomeDir } from './layout.js'
import { type ServiceRecord, servicePath } from './service.js'

const [home, id, profile, binary, portArg] = process.argv.slice(2)
if (!home || !id || !profile || !binary) throw new Error('missing supervisor arguments')
const port = Number(portArg ?? 0)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid mirror port')
const labHome = labHomeDir(home, id)
const controller = new AbortController()
const cancelStartup = () => controller.abort()
process.once('SIGTERM', cancelStartup)
process.once('SIGINT', cancelStartup)
process.once('disconnect', cancelStartup)
const result = await launchDsh({
  signal: controller.signal,
  dshBinary: binary,
  args: dshBootArgs(profile, port),
  cwd: labHome,
  env: { ...process.env, DSH_HOME: labHome, WORLD_LINE_LAB: id },
})
process.removeListener('SIGTERM', cancelStartup)
process.removeListener('SIGINT', cancelStartup)
process.removeListener('disconnect', cancelStartup)
if (!result.handle || result.kind !== 'ready') {
  process.send?.({ ok: false, detail: result.detail })
  if (process.connected) process.disconnect()
  process.exitCode = 1
} else {
  const handle = result.handle
  let record: ServiceRecord | undefined
  let stopping = false
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = async () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    await handle.stop()
    if (record) {
      record.state = 'stopped'
      await writeFileAtomic(servicePath(home, id), JSON.stringify(record), { mode: 0o600 })
    }
  }
  // The token exists only once the record does, after DSH is up; a request
  // in the window before that is refused (403) rather than crashing on an
  // unset record.
  const server = createControlServer({
    token: () => record?.controlToken,
    status: () => ({ id, url: handle.url }),
    stop: async () => {
      try {
        await stop()
        return { id }
      } finally {
        server.close()
      }
    },
  })
  try {
    if (controller.signal.aborted) throw new Error('startup cancelled')
    if (port !== 0 && handle.port !== port)
      throw new Error('DSH did not retain the requested mirror port')
    const health = await fetch(new URL('/', handle.url), { signal: AbortSignal.timeout(10000) })
    if (health.status >= 500) throw new Error('HTTP readiness failed')
    const controlPort = await listenLoopback(server)
    record = {
      id,
      hostname: hostname(),
      pid: process.pid,
      controlPort,
      controlToken: randomBytes(32).toString('hex'),
      port: handle.port,
      state: 'running',
    }
    await writeFileAtomic(servicePath(home, id), JSON.stringify(record), { mode: 0o600 })
    const shutdown = () => {
      void stop().finally(() => server.close())
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    // If DSH exits independently, do not keep a misleading live supervisor.
    timer = setInterval(() => {
      try {
        process.kill(handle.pid, 0)
      } catch {
        shutdown()
      }
    }, 1000)
    process.send?.(
      { ok: true, id, pid: process.pid, port: handle.port, url: handle.url },
      (error) => {
        if (error) shutdown()
        if (process.connected) process.disconnect()
      },
    )
  } catch (error) {
    await stop()
    server.close()
    process.send?.({
      ok: false,
      detail: `lab runtime setup failed: ${redactText(error instanceof Error ? error.message : String(error))}`,
    })
    if (process.connected) process.disconnect()
    process.exitCode = 1
  }
}
