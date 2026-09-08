import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
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
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(403)
    res.end()
    return
  }
  if (req.url === '/stop' && req.method === 'POST') controller.abort()
  else if (req.url !== '/status') {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ running, ready, error, stopping: controller.signal.aborted }))
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
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no control port')
      await writeFileAtomic(
        join(deploymentRoot(ctx), 'service.json'),
        JSON.stringify({ version: 1, port: address.port, token, pid: process.pid }),
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
