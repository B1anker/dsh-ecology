import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runLabUpdate } from '../commands/lab.js'
import type { CliContext } from '../context.js'
import { detectDrift } from '../domain/drift.js'
import { UsageError } from '../domain/errors.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { sha256Hex } from '../fs/hash.js'
import { withOperations } from '../fs/operation.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { requirePnpm } from '../lab/gate.js'
import { localSourceHash } from '../lab/local-source.js'
import { runCaptured } from '../lab/runner.js'
import { sourceContext } from '../lab/source.js'
import { type JobHandle, startScopedJob } from '../web/jobs.js'

/** Exact SemVer ordering; an unknown installed version never authorizes a downgrade. */
export function isNewerVersion(candidate: string, current: string | undefined): boolean {
  const parse = (v: string | undefined) =>
    v?.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/,
    )
  const a = parse(candidate),
    b = parse(current)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++)
    if (BigInt(a[i]!) !== BigInt(b[i]!)) return BigInt(a[i]!) > BigInt(b[i]!)
  if (!a[4] || !b[4]) return !a[4] && !!b[4]
  const x = a[4].split('.'),
    y = b[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const left = x[i],
      right = y[i]
    if (left === right) continue
    if (left === undefined || right === undefined) return right === undefined
    const ln = /^\d+$/.test(left),
      rn = /^\d+$/.test(right)
    if (ln && rn) return BigInt(left) > BigInt(right)
    if (ln !== rn) return !ln
    return left > right
  }
  return false
}
function policyPath(ctx: CliContext, sourceId: string) {
  return join(
    ctx.home,
    'world-line',
    'upgrade-policies',
    `${sha256Hex(ctx.profileName + '\0' + sourceId)}.json`,
  )
}
export async function upgradePolicy(
  ctx: CliContext,
  sourceId: string,
  enabled?: boolean,
  hours = 24,
) {
  await sourceContext(ctx, sourceId)
  const path = policyPath(ctx, sourceId)
  if (enabled === undefined)
    return readFile(path, 'utf8')
      .then(JSON.parse)
      .catch((e) => {
        if (e.code === 'ENOENT')
          return {
            version: 1,
            sourceId,
            profile: ctx.profileName,
            enabled: false,
            hours: 24,
            nextAt: null,
          }
        throw e
      })
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw new UsageError('检查间隔必须是 1–168 小时')
  const policy = {
    version: 1,
    profile: ctx.profileName,
    sourceId,
    enabled,
    hours,
    nextAt: new Date(Date.now() + hours * 3600000).toISOString(),
  }
  await withOperations([ctx.home], 'upgrade-policies', () =>
    writeFileAtomic(path, JSON.stringify(policy)),
  )
  return policy
}
export async function checkUpgrades(ctx: CliContext, sourceId: string, handle: JobHandle) {
  const source = await sourceContext(ctx, sourceId)
  const analysis = await analyzeProfile({
    home: source.home,
    profileName: ctx.profileName,
    adapter: adapterDsh01x,
  })
  const drift = await detectDrift(source.home, ctx.profileName, analysis)
  // The job itself owns the source operation lock; compare receipt directly with the saved healthy snapshot instead.
  const { readState } = await import('../vault/state.js'),
    { readSnapshotManifest } = await import('../vault/manifests.js')
  const state = await readState(source.home),
    lkg = state.lastKnownGood[ctx.profileName]
  if (!lkg) throw new UsageError('请先完成一次来源重启验证并记录稳定点，再启用升级检查')
  const baseline = await readSnapshotManifest(source.home, lkg)
  for (const dep of baseline.profile.dependencies.filter(
    (d) => d.kind === 'file' || d.kind === 'link',
  ))
    if (
      !dep.target ||
      !dep.localSourceHash ||
      (await localSourceHash(dep.target)) !== dep.localSourceHash
    )
      throw new UsageError('本地源码已偏离稳定点')
  if ((baseline.homePatch?.sha256 ?? null) !== (analysis.homePatch?.sha256 ?? null))
    throw new UsageError('home 配置已偏离稳定点')
  if (baseline.profile.receipt.tree !== analysis.receipt.tree)
    throw new UsageError('当前环境已偏离稳定点，请先验证当前组合')
  const rows = []
  for (const dep of analysis.dependencies.filter((d) => d.kind === 'registry')) {
    handle.setPhase(`检查 ${dep.name}`)
    const outcome = await runCaptured(
      requirePnpm(ctx.env).path,
      ['view', dep.name, 'dist-tags.latest', '--json'],
      { cwd: source.home, env: ctx.env, timeoutMs: 30000 },
    )
    if (outcome.exitCode !== 0) {
      rows.push({ name: dep.name, status: 'failed', reason: '无法查询版本' })
      continue
    }
    let version: unknown
    try {
      version = JSON.parse(outcome.stdout)
    } catch {
      rows.push({ name: dep.name, status: 'failed', reason: '版本响应无法解析' })
      continue
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
      rows.push({ name: dep.name, status: 'failed', reason: '无效版本' })
      continue
    }
    if (!isNewerVersion(version, dep.resolved?.version)) continue
    try {
      const result = await runLabUpdate(ctx, `${dep.name}@${version}`, {
        sourceId,
        keep: true,
        clientProbes: true,
        captureBaseline: true,
        onLabCreated: (id) => handle.setLabId(id),
        onProbe: (p) => handle.pushProbe(p),
      })
      rows.push({
        name: dep.name,
        from: dep.resolved?.version ?? dep.spec,
        to: version,
        labId: result.labId,
        status: result.ok ? 'verified' : 'failed',
      })
    } catch {
      rows.push({
        name: dep.name,
        from: dep.resolved?.version,
        to: version,
        status: 'failed',
        reason: '验证未完成，请查看任务探针',
      })
    }
  }
  const after = await analyzeProfile({
    home: source.home,
    profileName: ctx.profileName,
    adapter: adapterDsh01x,
  })
  if (
    after.receipt.tree !== analysis.receipt.tree ||
    (after.homePatch?.sha256 ?? null) !== (analysis.homePatch?.sha256 ?? null)
  )
    throw new UsageError('检查期间来源环境已变化，升级实验已保留，请重新检查后再合入')
  for (const dep of baseline.profile.dependencies.filter(
    (d) => d.kind === 'file' || d.kind === 'link',
  ))
    if (!dep.target || (await localSourceHash(dep.target)) !== dep.localSourceHash)
      throw new UsageError('检查期间本地源码已变化，请重新检查')
  const result = {
    ok: true,
    profile: ctx.profileName,
    sourceId,
    baseline: lkg,
    checkedAt: ctx.now().toISOString(),
    rows,
    notes: drift.note,
  }
  await writeFileAtomic(
    join(ctx.home, 'world-line', 'upgrade-results', `${handle.id}.json`),
    JSON.stringify(result),
  )
  return result
}
export async function upgradeResults(ctx: CliContext) {
  const root = join(ctx.home, 'world-line', 'upgrade-results')
  const files = await readdir(root).catch((e) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  const values = []
  for (const f of files.filter((f) => /^job-[A-Za-z0-9-]+\.json$/.test(f)).slice(-100)) {
    const result = JSON.parse(await readFile(join(root, f), 'utf8'))
    if (result.profile === ctx.profileName) values.push(result)
  }
  return values
}
export async function upgradeTick(ctx: CliContext) {
  const root = join(ctx.home, 'world-line', 'upgrade-policies')
  const files = await readdir(root).catch((e) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
    await withOperations([ctx.home], 'upgrade-policies', async () => {
      const path = join(root, file),
        p = JSON.parse(await readFile(path, 'utf8'))
      if (
        p.version !== 1 ||
        p.profile !== ctx.profileName ||
        p.enabled !== true ||
        !Number.isInteger(p.hours) ||
        p.hours < 1 ||
        p.hours > 168 ||
        !Number.isFinite(Date.parse(p.nextAt)) ||
        Date.parse(p.nextAt) > Date.now()
      )
        return
      await sourceContext(ctx, p.sourceId)
      p.nextAt = new Date(Date.now() + p.hours * 3600000).toISOString()
      await writeFileAtomic(path, JSON.stringify(p))
      const job = startScopedJob(ctx, p.sourceId, 'upgrade-check', (handle) =>
        checkUpgrades(ctx, p.sourceId, handle),
      )
      p.lastJobId = job.id
      await writeFileAtomic(path, JSON.stringify(p))
    }).catch(() => {})
  }
}
