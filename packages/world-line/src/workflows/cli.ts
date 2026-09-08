import { readFile } from 'node:fs/promises'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { migratePackageCache, prunePackageCache } from '../lab/cache-maintenance.js'
import { sourceContext } from '../lab/source.js'
import type { JobHandle } from '../web/jobs.js'
import {
  answerInvestigation,
  createInvestigation,
  listInvestigations,
  readInvestigation,
  type Verdict,
} from './bisect.js'
import { versionMatrix } from './compatibility.js'
import {
  activateDeployment,
  configureDeployment,
  deploymentStatus,
  rollbackDeployment,
  runDeploymentWatchdog,
  stageDeployment,
} from './deployment.js'
import { deploymentService } from './deployment-service.js'
import { previewInvestigation, runInvestigation, skipInterruptedTrial } from './investigate-run.js'
import { exportEnvironment, importEnvironment } from './portable.js'
import { checkUpgrades, upgradePolicy, upgradeResults, upgradeTick } from './upgrades.js'

const handle = (): JobHandle => ({
  id: `job-cli-${Date.now()}`,
  kind: 'investigate',
  setPhase: () => {},
  pushProbe: () => {},
  setLabId: () => {},
  setTransactionId: () => {},
})
export const workflowCommands = new Set([
  'investigate',
  'export',
  'import',
  'matrix',
  'upgrade',
  'deployment',
  'cache',
])
export async function workflowCli(ctx: CliContext, command: string, args: string[]) {
  const flags = new Map<string, string | boolean>(),
    rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a.startsWith('--')) {
      if (['--yes', '--automatic', '--enabled', '--disabled'].includes(a)) flags.set(a, true)
      else {
        const v = args[++i]
        if (!v || v.startsWith('--')) throw new UsageError(`缺少 ${a} 的值`)
        flags.set(a, v)
      }
    } else rest.push(a)
  }
  const source = String(flags.get('--source') ?? 'origin'),
    sub = rest[0],
    id = rest[1]
  const yes = () => {
    if (flags.get('--yes') !== true) throw new UsageError('此操作需要 --yes 明确确认')
  }
  if (command === 'cache') {
    yes()
    if (sub === 'prune') return prunePackageCache(ctx, true)
    if (sub === 'migrate' && id) return migratePackageCache(ctx, id)
    throw new UsageError('cache prune --yes | cache migrate <lab> --yes')
  }
  if (command === 'export') {
    if (!sub || typeof flags.get('--output') !== 'string')
      throw new UsageError('export <snapshot> --output <file> [--source <id>]')
    const b = await exportEnvironment(await sourceContext(ctx, source), sub)
    await writeFileAtomic(String(flags.get('--output')), JSON.stringify(b, null, 2))
    return { path: flags.get('--output'), requiredFiles: b.requiredFiles }
  }
  if (command === 'import') {
    yes()
    if (!sub) throw new UsageError('import <bundle.json> --yes [--required-files <private.json>]')
    const required = flags.has('--required-files')
      ? JSON.parse(await readFile(String(flags.get('--required-files')), 'utf8'))
      : {}
    return importEnvironment(ctx, await readFile(sub, 'utf8'), source, required, handle())
  }
  if (command === 'matrix') {
    yes()
    return versionMatrix(ctx, rest, source, handle())
  }
  if (command === 'investigate') {
    if (sub === 'list') return listInvestigations(ctx)
    if (sub === 'create') {
      if (id !== 'time' && id !== 'plugins')
        throw new UsageError('investigate create time|plugins [--good <snap>] [--bad <snap>]')
      return createInvestigation(
        ctx,
        id,
        source,
        flags.get('--good') as string | undefined,
        flags.get('--bad') as string | undefined,
      )
    }
    if (!id) throw new UsageError('investigate show|run|answer|skip-interrupted <id>')
    if (sub === 'preview') return previewInvestigation(ctx, id)
    if (sub === 'show') return readInvestigation(ctx, id)
    if (sub === 'run') return runInvestigation(ctx, id, handle(), flags.has('--automatic'))
    if (sub === 'answer') {
      if (!rest[2]) throw new UsageError('investigate answer <id> good|bad|skip --revision <n>')
      return answerInvestigation(ctx, id, Number(flags.get('--revision')), rest[2] as Verdict)
    }
    if (sub === 'skip-interrupted') {
      yes()
      return skipInterruptedTrial(ctx, id)
    }
  }
  if (command === 'upgrade') {
    if (sub === 'results') return upgradeResults(ctx)
    if (sub === 'check') {
      yes()
      return checkUpgrades(ctx, source, handle())
    }
    if (sub === 'policy') {
      if (!flags.has('--enabled') && !flags.has('--disabled')) return upgradePolicy(ctx, source)
      yes()
      return upgradePolicy(ctx, source, flags.has('--enabled'), Number(flags.get('--hours') ?? 24))
    }
    if (sub === 'watch') {
      const controller = new AbortController(),
        stop = () => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        while (!controller.signal.aborted) {
          await upgradeTick(ctx)
          await new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer)
                controller.signal.removeEventListener('abort', done)
                resolve()
              },
              timer = setTimeout(done, 60000)
            controller.signal.addEventListener('abort', done, { once: true })
          })
        }
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
      return { stopped: true }
    }
  }
  if (command === 'deployment') {
    if (sub === 'status') return deploymentStatus(ctx)
    if (sub === 'stage' && id) {
      yes()
      return stageDeployment(ctx, id)
    }
    if (sub === 'activate' && id) {
      yes()
      return activateDeployment(ctx, id)
    }
    if (sub === 'rollback') {
      yes()
      return rollbackDeployment(ctx)
    }
    if (sub === 'config') {
      yes()
      return configureDeployment(ctx, flags.has('--enabled'), Number(flags.get('--threshold') ?? 3))
    }
    if (sub === 'start' || sub === 'stop') {
      yes()
      return deploymentService(ctx, sub)
    }
    if (sub === 'run') {
      yes()
      const controller = new AbortController(),
        stop = () => controller.abort()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        await runDeploymentWatchdog(ctx, controller.signal, (value) =>
          value ? process.stdout.write(`部署入口 ${value.url}\n`) : undefined,
        )
      } finally {
        process.removeListener('SIGINT', stop)
        process.removeListener('SIGTERM', stop)
      }
      return { stopped: true }
    }
  }
  throw new UsageError('无效工作流命令；参阅 completion-ledger 与 README 的排障、交付和部署用法')
}
