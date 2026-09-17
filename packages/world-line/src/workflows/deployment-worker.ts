/**
 * Detached deployment watchdog: runs `runDeploymentWatchdog` for one profile
 * and answers the CLI over the loopback control endpoint (control-server.ts)
 * whose port and token it writes to `service.json` once it is listening. The
 * script is the process shell; everything it does is in the modules it calls.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createControlServer, listenLoopback } from '../control-server.js'
import { redactText } from '../domain/redaction.js'
import { loadDshEnvironment, loadExperimentEnvironment } from '../environment.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { deploymentRoot, runDeploymentWatchdog } from './deployment.js'

const [home, profileName] = process.argv.slice(2)
if (!home || !profileName) throw new Error('missing deployment context')
const env = await loadDshEnvironment(home, process.env)
const ctx = {
  home,
  profileName,
  cwd: home,
  env,
  experimentEnv: await loadExperimentEnvironment(env, process.env),
  json: true,
  breakStaleLock: process.argv[4] === 'break-stale',
  now: () => new Date(),
}
const controller = new AbortController(),
  token = randomBytes(32).toString('hex')
let ready: { slot: string; url: string; port: number } | null = null,
  error: string | null = null,
  running = true
const server = createControlServer({
  token: () => token,
  status: () => ({ running, ready, error, stopping: controller.signal.aborted }),
  stop: () => controller.abort(),
})
process.on('SIGTERM', () => controller.abort())
process.on('SIGINT', () => controller.abort())
try {
  await runDeploymentWatchdog(
    ctx,
    controller.signal,
    (value) => {
      ready = value
    },
    async () => {
      const port = await listenLoopback(server)
      await writeFileAtomic(
        join(deploymentRoot(ctx), 'service.json'),
        JSON.stringify({ version: 1, port, token, pid: process.pid }),
      )
      process.send?.({ running: true, starting: true })
    },
  )
} catch (e) {
  error = redactText(e instanceof Error ? e.message : String(e))
  await writeFileAtomic(join(deploymentRoot(ctx), 'worker-error.json'), JSON.stringify({ error }))
} finally {
  running = false
  ready = null
  server.close()
}
