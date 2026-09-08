import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { redactText } from '../domain/redaction.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { cloneTree } from '../fs/clone.js'
import { sha256Hex } from '../fs/hash.js'
import { withOperations } from '../fs/operation.js'
import { dshBootArgs, dshDumpArgs } from '../host-adapters/dsh-0.1.x.js'
import { runClientProbe } from '../lab/browser.js'
import { withPackageCache } from '../lab/cache-maintenance.js'
import { parseComposedTreeText } from '../lab/compose.js'
import { checkCoreBaseline } from '../lab/core-baseline.js'
import { requireKnownHost, requirePnpm } from '../lab/gate.js'
import { rebaseHomePaths } from '../lab/home-inheritance.js'
import { launchDsh } from '../lab/launcher.js'
import { labHomeDir, labProbePath } from '../lab/layout.js'
import { readLabManifest } from '../lab/manifest.js'
import { classifyClientGate } from '../lab/promote.js'
import { runCaptured } from '../lab/runner.js'
import { installationStorePolicy } from '../lab/store.js'
import { syncDir } from '../lab/swap.js'
import { freezeLocalProfile } from '../lab/vendor.js'

export const slotPattern = /^slot-[a-f0-9-]{36}$/
export function deploymentRoot(ctx: CliContext) {
  return join(ctx.home, 'world-line', 'deployments', sha256Hex(ctx.profileName).slice(0, 16))
}
export interface DeploymentState {
  version: 1
  profile: string
  stable: string | null
  previous: string | null
  failures: number
  threshold: number
  enabled: boolean
  notice: string
  updatedAt: string
  lastRollback?: { from: string; to: string; reason: string; at: string }
}
async function state(ctx: CliContext): Promise<DeploymentState> {
  return readFile(join(deploymentRoot(ctx), 'state.json'), 'utf8')
    .then((text) => {
      const s = JSON.parse(text)
      if (s.version !== 1 || s.profile !== ctx.profileName) throw new UsageError('部署状态损坏')
      return s
    })
    .catch((e) => {
      if (e.code === 'ENOENT')
        return {
          version: 1,
          profile: ctx.profileName,
          stable: null,
          previous: null,
          failures: 0,
          threshold: 3,
          enabled: false,
          notice: '尚未启用独立 A/B 启动器',
          updatedAt: ctx.now().toISOString(),
        }
      throw e
    })
}
async function save(ctx: CliContext, s: DeploymentState) {
  s.updatedAt = ctx.now().toISOString()
  await writeFileAtomic(join(deploymentRoot(ctx), 'state.json'), JSON.stringify(s))
}
export async function activeSlot(ctx: CliContext) {
  const value = await readlink(join(deploymentRoot(ctx), 'current')).catch((e) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (value !== null && !slotPattern.test(value)) throw new UsageError('部署指针不可信')
  return value
}
async function slot(ctx: CliContext, id: string) {
  if (!slotPattern.test(id)) throw new UsageError('无效部署编号')
  const record = JSON.parse(await readFile(join(deploymentRoot(ctx), id, 'slot.json'), 'utf8'))
  if (
    record.version !== 1 ||
    record.id !== id ||
    record.profile !== ctx.profileName ||
    record.verified !== true
  )
    throw new UsageError('部署未验证或记录损坏')
  return record
}
async function point(ctx: CliContext, id: string) {
  await slot(ctx, id)
  const root = deploymentRoot(ctx),
    temp = join(root, `.next-${randomUUID()}`)
  await symlink(id, temp)
  try {
    await rename(temp, join(root, 'current'))
    await syncDir(root)
  } finally {
    await rm(temp, { force: true })
  }
}
export async function deploymentStatus(ctx: CliContext) {
  const root = deploymentRoot(ctx),
    s = await state(ctx),
    names = await readdir(root).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
  const slots = []
  for (const id of names.filter((n) => slotPattern.test(n))) {
    try {
      slots.push(await slot(ctx, id))
    } catch {
      slots.push({ id, verified: false })
    }
  }
  return { ...s, active: await activeSlot(ctx), slots }
}
export async function activateDeployment(
  ctx: CliContext,
  id: string,
  boundary?: (phase: string) => Promise<void>,
) {
  return deploymentLock(ctx, async () => {
    await slot(ctx, id)
    const s = await state(ctx),
      previous = await activeSlot(ctx)
    if (previous === id) return deploymentStatus(ctx)
    // Persist fallback BEFORE the authoritative atomic pointer swap. A crash cannot lose it.
    s.previous = previous
    s.failures = 0
    s.enabled = true
    s.notice = '已切换部署；外部守护进程将在下一次启动/检测时采用新指针'
    if (!s.stable) s.stable = id
    await save(ctx, s)
    await boundary?.('decision')
    await point(ctx, id)
    await boundary?.('pointer')
    return deploymentStatus(ctx)
  })
}
export async function rollbackDeployment(ctx: CliContext) {
  const s = await state(ctx),
    active = await activeSlot(ctx),
    target = s.stable !== active ? s.stable : s.previous
  if (!target) throw new UsageError('没有可回退部署')
  return activateDeployment(ctx, target)
}
export async function configureDeployment(ctx: CliContext, enabled: boolean, threshold = 3) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10)
    throw new UsageError('失败阈值必须为 1–10')
  return deploymentLock(ctx, async () => {
    const s = await state(ctx)
    s.enabled = enabled
    s.threshold = threshold
    await save(ctx, s)
    return deploymentStatus(ctx)
  })
}
export async function recordBootResult(ctx: CliContext, id: string, healthy: boolean, reason = '') {
  return deploymentLock(ctx, async () => {
    const s = await state(ctx)
    if ((await activeSlot(ctx)) !== id) return { changed: true }
    if (healthy) {
      s.failures = 0
      s.stable = id
      s.notice = s.lastRollback
        ? `当前部署启动正常；上次自动回退：${s.lastRollback.reason}`
        : '当前部署已通过浏览器启动验证'
    } else {
      s.failures++
      s.notice = `启动失败 ${s.failures}/${s.threshold}：${redactText(reason)}`
      if (s.enabled && s.failures >= s.threshold) {
        const fallback = s.stable !== id ? s.stable : s.previous
        if (fallback) {
          await slot(ctx, fallback)
          s.lastRollback = {
            from: id,
            to: fallback,
            reason: redactText(reason),
            at: ctx.now().toISOString(),
          }
          s.enabled = false
          s.notice = `已自动回退到 ${fallback}；原部署 ${id} 连续启动失败。请检查后重新启用守护。`
          await save(ctx, s)
          await point(ctx, fallback)
          return { rolledBack: true, active: fallback }
        }
        s.enabled = false
        s.notice += '；没有其他已验证部署，已停止自动重试'
      }
    }
    await save(ctx, s)
    return { healthy, failures: s.failures }
  })
}
async function stageDeploymentInternal(ctx: CliContext, labId: string) {
  return withOperations([labHomeDir(ctx.home, labId)], ctx.profileName, async () => {
    const lab = await readLabManifest(ctx.home, labId)
    if (
      lab.source.profileName !== ctx.profileName ||
      lab.state !== 'passed' ||
      lab.hostExperiment ||
      classifyClientGate(
        JSON.parse(await readFile(labProbePath(ctx.home, labId), 'utf8')).probes,
      ) !== 'pass'
    )
      throw new UsageError('请选择通过浏览器验证的同版本实验')
    const host = requireKnownHost(ctx),
      id = `slot-${randomUUID()}`,
      root = join(deploymentRoot(ctx), id),
      home = join(root, 'home'),
      source = labHomeDir(ctx.home, labId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await cloneTree(
        source,
        home,
        new Set(['node_modules', 'world-line', '.git', 'logs', 'run', 'tmp']),
        true,
      )
      for (const relative of ['cordis.patch.yml', `profiles/${ctx.profileName}/cordis.patch.yml`]) {
        const path = join(home, relative),
          text = await readFile(path, 'utf8').catch((e) => {
            if (e.code === 'ENOENT') return null
            throw e
          })
        if (text !== null)
          await writeFileAtomic(path, dump(rebaseHomePaths(load(text), source, home)))
      }
      const dir = join(home, 'profiles', ctx.profileName),
        store = installationStorePolicy(join(root, 'store')),
        env = {
          ...store.environment(ctx.experimentEnv ?? ctx.env),
          DSH_HOME: home,
          npm_config_ignore_scripts: 'true',
          pnpm_config_ignore_scripts: 'true',
        }
      await freezeLocalProfile(dir, join(source, 'profiles', ctx.profileName), join(root, 'vendor'))
      const install = await runCaptured(
        requirePnpm(ctx.env).path,
        ['install', '--prod', '--ignore-scripts', ...store.flags],
        { cwd: dir, env, timeoutMs: 180000 },
      )
      if (install.exitCode !== 0 || install.spawnError || install.timedOut)
        throw new UsageError('部署依赖安装失败')
      const composed = await runCaptured(host.binary.path, dshDumpArgs(ctx.profileName), {
        cwd: dir,
        env,
        timeoutMs: 60000,
      })
      if (composed.exitCode !== 0) throw new UsageError('部署 compose 失败')
      await checkCoreBaseline(ctx, host, parseComposedTreeText(composed.stdout, 'deployment'))
      const boot = await launchDsh({
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: home,
        env,
      })
      if (boot.kind !== 'ready' || !boot.handle) throw new UsageError('部署启动失败')
      try {
        const result = await runClientProbe({ url: boot.handle.url })
        if (result.signal.kind !== 'ready') throw new UsageError('部署浏览器验证未通过')
      } finally {
        await boot.handle.stop()
      }
      const record = {
        version: 1,
        id,
        profile: ctx.profileName,
        labId,
        hostVersion: host.raw,
        verified: true,
        createdAt: ctx.now().toISOString(),
      }
      await writeFileAtomic(join(root, 'slot.json'), JSON.stringify(record))
      return record
    } catch (e) {
      await writeFileAtomic(
        join(root, 'failure.json'),
        JSON.stringify({ error: redactText(e instanceof Error ? e.message : String(e)) }),
      )
      throw e
    }
  })
}
/** External startup path: never requires a working DSH Web panel. */
export async function runDeploymentWatchdog(
  ctx: CliContext,
  signal: AbortSignal,
  onReady: (value: { slot: string; url: string; port: number } | null) => void = () => {},
  onStarted: () => Promise<void> = async () => {},
) {
  const { acquireLock } = await import('../fs/lock.js')
  const lock = await acquireLock({
    lockPath: join(deploymentRoot(ctx), 'watchdog.lock'),
    purpose: 'external deployment watchdog',
    breakStale: ctx.breakStaleLock,
  })
  try {
    await onStarted()
    while (!signal.aborted) {
      onReady(null)
      const status = await deploymentStatus(ctx),
        id = status.active
      if (!id) throw new UsageError('请先准备并激活部署')
      const record = await slot(ctx, id),
        host = requireKnownHost(ctx)
      if (host.raw !== record.hostVersion) throw new UsageError('当前宿主版本与部署验证版本不符')
      const home = join(deploymentRoot(ctx), id, 'home')
      const boot = await launchDsh({
        signal,
        dshBinary: host.binary.path,
        args: dshBootArgs(ctx.profileName, 0),
        cwd: home,
        env: {
          ...installationStorePolicy(join(deploymentRoot(ctx), id, 'store')).environment(
            ctx.experimentEnv ?? ctx.env,
          ),
          DSH_HOME: home,
          npm_config_ignore_scripts: 'true',
          pnpm_config_ignore_scripts: 'true',
        },
      })
      let healthy = false
      try {
        if (boot.kind === 'ready' && boot.handle && !signal.aborted) {
          const result = await runClientProbe({ url: boot.handle.url })
          healthy = result.signal.kind === 'ready'
          if (healthy) {
            await recordBootResult(ctx, id, true)
            onReady({ slot: id, url: boot.handle.url, port: boot.handle.port })
            while (!signal.aborted && (await activeSlot(ctx)) === id) {
              await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer)
                    signal.removeEventListener('abort', done)
                    resolve()
                  },
                  timer = setTimeout(done, 10000)
                signal.addEventListener('abort', done, { once: true })
              })
              if (signal.aborted) break
              try {
                const r = await fetch(boot.handle.url, { signal: AbortSignal.timeout(5000) })
                if (r.status >= 500) {
                  healthy = false
                  break
                }
              } catch {
                healthy = false
                break
              }
            }
          }
        }
      } finally {
        await boot.handle?.stop()
      }
      if (signal.aborted) break
      if ((await activeSlot(ctx)) !== id) continue
      if (!healthy) {
        const result = await recordBootResult(
          ctx,
          id,
          false,
          '宿主启动、浏览器验收或运行健康检查失败',
        )
        if ('rolledBack' in result) continue
        if (!(await state(ctx)).enabled) break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } finally {
    await lock.release()
  }
}

export async function stageDeployment(...args: Parameters<typeof stageDeploymentInternal>) {
  return withPackageCache(args[0].home, () => stageDeploymentInternal(...args))
}

function deploymentLock<T>(ctx: CliContext, run: () => Promise<T>) {
  return withOperations([ctx.home], `deployment:${ctx.profileName}`, run, ctx.breakStaleLock)
}
