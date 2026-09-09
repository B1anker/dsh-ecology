import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLabConfigApply } from '../commands/lab.js'
import { reconcilePromotion, runRecovery } from '../commands/recovery.js'
import { runTimelinePrune } from '../commands/timeline.js'
import type { CliContext } from '../context.js'
import { diffManifests } from '../domain/diff.js'
import { detectDrift } from '../domain/drift.js'
import { UsageError } from '../domain/errors.js'
import { redactData } from '../domain/redact-data.js'
import { analyzeProfile, type SnapshotManifest } from '../domain/snapshot.js'
import { sha256Hex } from '../fs/hash.js'
import { withOperations } from '../fs/operation.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { artifactCleanup, artifactRoot } from '../lab/artifacts.js'
import { migratePackageCache, prunePackageCache } from '../lab/cache-maintenance.js'
import { labHomeDir } from '../lab/layout.js'
import { readLabManifest } from '../lab/manifest.js'
import { sourceContext } from '../lab/source.js'
import {
  gcApply,
  gcPreview,
  gcPurge,
  gcRecords,
  gcRestore,
  storageUsage,
} from '../vault/maintenance.js'
import {
  answerInvestigation,
  createInvestigation,
  listInvestigations,
  readInvestigation,
  type Verdict,
} from '../workflows/bisect.js'
import { versionMatrix } from '../workflows/compatibility.js'
import {
  activateDeployment,
  configureDeployment,
  deploymentStatus,
  rollbackDeployment,
  stageDeployment,
} from '../workflows/deployment.js'
import { deploymentService } from '../workflows/deployment-service.js'
import {
  previewInvestigation,
  runInvestigation,
  skipInterruptedTrial,
} from '../workflows/investigate-run.js'
import { exportEnvironment, importEnvironment } from '../workflows/portable.js'
import { checkUpgrades, upgradePolicy, upgradeResults } from '../workflows/upgrades.js'
import { checkedSnapshot, currentManifest, lineContext, snapshotEvents } from './insights.js'
import { startJob } from './jobs.js'
import { pluginDetails } from './plugin-details.js'

function comparisonDiff(a: SnapshotManifest, b: SnapshotManifest) {
  const diff = diffManifests(a, b)
  return {
    ...diff,
    dependencies: diff.dependencies.map((entry) => {
      const before = a.profile.dependencies.find((d) => d.name === entry.name),
        after = b.profile.dependencies.find((d) => d.name === entry.name)
      return {
        ...entry,
        before: before?.resolved?.version ?? before?.spec,
        after: after?.resolved?.version ?? after?.spec,
      }
    }),
  }
}
export async function reportContext(ctx: CliContext, id: string, lineId?: string) {
  if (id.startsWith('lab-')) {
    const lab = await readLabManifest(ctx.home, id)
    if (lab.source.profileName !== ctx.profileName) throw new UsageError('实验不属于当前 profile')
    return ctx
  }
  const target = await lineContext(ctx, lineId ?? 'origin')
  await checkedSnapshot(target, id)
  return target
}
export async function extendedAction(
  ctx: CliContext,
  body: Record<string, unknown>,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const handlers: Record<string, () => Promise<unknown>> = {
    'cache-prune': async () => prunePackageCache(ctx, body.runtimeStopped === true),
    'cache-migrate': async () => migratePackageCache(ctx, body.id as string),
    'deployment-status': async () => ({
      ...(await deploymentStatus(ctx)),
      service: await deploymentService(ctx, 'status'),
    }),
    'deployment-stage': async () => {
      const id = body.id as string
      await reportContext(ctx, id)
      const job = startJob('deployment-stage', () => stageDeployment(ctx, id), id, {
        home: ctx.home,
        profileName: ctx.profileName,
        resource: 'origin',
      })
      return { jobId: job.id }
    },
    'deployment-activate': async () => activateDeployment(ctx, body.id as string),
    'deployment-rollback': async () => rollbackDeployment(ctx),
    'deployment-config': async () =>
      configureDeployment(ctx, body.enabled === true, Number(body.threshold)),
    'deployment-service': async () => {
      if (!['start', 'stop', 'status'].includes(body.operation as string))
        throw new UsageError('无效守护操作')
      return deploymentService(
        { ...ctx, breakStaleLock: body.breakStale === true },
        body.operation as 'start' | 'stop' | 'status',
      )
    },
    'version-matrix': async () => {
      const sourceId = (body.sourceId as string | undefined) ?? 'origin'
      await sourceContext(ctx, sourceId)
      const job = startJob(
        'version-matrix',
        (h) => versionMatrix(ctx, body.versions as string[], sourceId, h),
        undefined,
        { home: ctx.home, profileName: ctx.profileName, resource: sourceId },
      )
      return { jobId: job.id }
    },
    'upgrade-results': async () => upgradeResults(ctx),
    'upgrade-policy': async () =>
      upgradePolicy(
        ctx,
        body.id as string,
        body.enabled as boolean | undefined,
        body.hours ? Number(body.hours) : 24,
      ),
    'upgrade-check': async () => {
      const sourceId = body.id as string
      await sourceContext(ctx, sourceId)
      const job = startJob('upgrade-check', (h) => checkUpgrades(ctx, sourceId, h), undefined, {
        home: ctx.home,
        profileName: ctx.profileName,
        resource: sourceId,
      })
      return { jobId: job.id }
    },
    'environment-export': async () =>
      exportEnvironment(await lineContext(ctx, body.id as string), body.snapshotId as string),
    'environment-import': async () => {
      const sourceId = (body.sourceId as string | undefined) ?? 'origin'
      await sourceContext(ctx, sourceId)
      const job = startJob(
        'environment-import',
        (handle) =>
          importEnvironment(
            ctx,
            body.bundleText as string,
            sourceId,
            (body.requiredFiles as Record<string, string>) ?? {},
            handle,
          ),
        undefined,
        { home: ctx.home, profileName: ctx.profileName, resource: sourceId },
      )
      return { jobId: job.id }
    },
    investigations: async () => listInvestigations(ctx),
    'investigation-create': async () => {
      if (body.kind !== 'time' && body.kind !== 'plugins') throw new UsageError('无效排障方式')
      return createInvestigation(
        ctx,
        body.kind,
        body.sourceId as string | undefined,
        body.good as string | undefined,
        body.bad as string | undefined,
      )
    },
    'investigation-run': async () => {
      const s = await readInvestigation(ctx, body.id as string)
      const job = startJob(
        'investigate',
        (handle) => runInvestigation(ctx, s.id, handle, body.automatic === true),
        undefined,
        { home: ctx.home, profileName: ctx.profileName, resource: s.sourceId },
      )
      return { jobId: job.id }
    },
    'investigation-preview': async () => previewInvestigation(ctx, body.id as string),
    'investigation-answer': async () =>
      answerInvestigation(ctx, body.id as string, Number(body.revision), body.verdict as Verdict),
    'investigation-skip-interrupted': async () =>
      skipInterruptedTrial({ ...ctx, breakStaleLock: body.breakStale === true }, body.id as string),
    'artifact-cleanup-preview': async () => {
      await reportContext(ctx, body.id as string)
      return artifactCleanup(await artifactRoot(ctx.home, body.id as string))
    },
    'artifact-cleanup-apply': async () => {
      const id = body.id as string
      await reportContext(ctx, id)
      return withOperations([labHomeDir(ctx.home, id)], ctx.profileName, async () =>
        artifactCleanup(await artifactRoot(ctx.home, id), true, body.revision as string),
      )
    },
    'recovery-list': async () => runRecovery(await recoveryContext(ctx, body.id as string)),
    'recovery-apply': async () => {
      const target = {
        ...(await recoveryContext(ctx, body.id as string)),
        breakStaleLock: body.breakStale === true,
      }
      if (body.runtimeStopped !== true) throw new UsageError('请先停止相关安装器和验证进程')
      return body.transaction
        ? reconcilePromotion(target, body.recordId as string, true)
        : runRecovery(target, body.recordId as string)
    },
    'gc-records': async () => gcRecords((await lineContext(ctx, body.id as string)).home),
    storage: async () => storageUsage((await lineContext(ctx, body.id as string)).home),
    'storage-prune-preview': async () => {
      const plan = await runTimelinePrune(await lineContext(ctx, body.id as string), {})
      return { ...plan, revision: sha256Hex(JSON.stringify(plan)) }
    },
    'storage-prune-apply': async () => {
      const target = await lineContext(ctx, body.id as string)
      return withOperations([target.home], 'vault', async () => {
        const plan = await runTimelinePrune(target, {})
        if (sha256Hex(JSON.stringify(plan)) !== body.revision)
          throw new UsageError('快照已变化，请重新预览')
        return runTimelinePrune(target, { yes: true })
      })
    },
    'gc-purge': async () =>
      gcPurge((await lineContext(ctx, body.id as string)).home, body.recordId as string),
    'gc-preview': async () => gcPreview((await lineContext(ctx, body.id as string)).home),
    'gc-apply': async () =>
      gcApply((await lineContext(ctx, body.id as string)).home, body.revision as string),
    'gc-restore': async () =>
      gcRestore((await lineContext(ctx, body.id as string)).home, body.recordId as string),
    'lab-diff': async () => {
      const lab = await readLabManifest(ctx.home, body.id as string)
      if (lab.source.profileName !== ctx.profileName) throw new UsageError('实验不属于当前 profile')
      if (!lab.source.baselineSnapshotId)
        throw new UsageError(
          '旧实验没有验证前基线，请从来源重新创建验证；不能用已变化的当前环境代替历史基线',
        )
      const source = await sourceContext(ctx, lab.source.parentLabId)
      const before = await checkedSnapshot(source, lab.source.baselineSnapshotId)
      const after = await currentManifest(
        await lineContext(ctx, body.id as string),
        body.id as string,
      )
      return redactData({
        at: ctx.now().toISOString(),
        from: { id: before.id, at: before.createdAt },
        to: { id: after.id, at: after.createdAt },
        diff: comparisonDiff(before, after),
      })
    },
    composition: async () => {
      const target = await lineContext(ctx, body.id as string)
      const a = await analyzeProfile({
        home: target.home,
        profileName: target.profileName,
        adapter: adapterDsh01x,
      })
      const details = await pluginDetails(target, a.dependencies)
      return redactData({
        id: body.id,
        at: ctx.now().toISOString(),
        receipt: a.receipt.tree,
        drift: await detectDrift(target.home, target.profileName, a),
        dependencies: a.dependencies.map((dep) => ({
          ...dep,
          ...details.find((detail) => detail.name === dep.name),
          bundle: a.manifest?.bundles.includes(dep.name) ?? false,
          core: (
            adapterDsh01x.profile.templates[target.profileName]?.bundles ??
            adapterDsh01x.profile.defaultBundles
          ).includes(dep.name),
        })),
        warnings: [
          a.manifestParseError,
          a.lockfileParseError,
          ...a.files.map((f) => f.parseError),
        ].filter(Boolean),
      })
    },
    'snapshot-list': async () =>
      snapshotEvents(await lineContext(ctx, body.id as string), body.id as string),
    'snapshot-compare': async () => {
      const read = async (value: unknown) => {
        const ref = value as Record<string, unknown>
        if (
          !ref ||
          typeof ref.lineId !== 'string' ||
          !['current', 'snapshot'].includes(ref.kind as string) ||
          Object.keys(ref).some((k) => !['lineId', 'kind', 'snapshotId'].includes(k))
        )
          throw new UsageError('无效比较引用')
        const target = await lineContext(ctx, ref.lineId)
        if (ref.kind === 'current') return currentManifest(target, ref.lineId)
        if (typeof ref.snapshotId !== 'string') throw new UsageError('请选择历史快照')
        return checkedSnapshot(target, ref.snapshotId)
      }
      const [a, b] = await Promise.all([read(body.from), read(body.to)])
      return redactData({
        at: ctx.now().toISOString(),
        from: { id: a.id, at: a.createdAt, receipt: a.profile.receipt.tree },
        to: { id: b.id, at: b.createdAt, receipt: b.profile.receipt.tree },
        diff: comparisonDiff(a, b),
      })
    },
    'lab-config-apply': async () => {
      const sourceId = (body.sourceId as string | undefined) ?? 'origin'
      await sourceContext(ctx, sourceId)
      const job = startJob(
        'lab-config-apply',
        async (handle) => {
          const dir = await mkdtemp(join(tmpdir(), 'dsh-config-'))
          try {
            const file = join(dir, 'patch.yml')
            await writeFile(file, body.text as string, { mode: 0o600 })
            return await runLabConfigApply(ctx, file, {
              sourceId,
              keep: true,
              clientProbes: true,
              captureBaseline: true,
              interactive: body.interactive === true,
              onProbe: (p) => handle.pushProbe(p),
              onLabCreated: (id) => handle.setLabId(id),
            })
          } finally {
            await rm(dir, { recursive: true, force: true })
          }
        },
        undefined,
        { home: ctx.home, profileName: ctx.profileName, resource: sourceId },
      )
      return { jobId: job.id }
    },
  }
  const handler = handlers[body.action as string]
  return handler ? { handled: true, result: await handler() } : { handled: false }
}

async function recoveryContext(ctx: CliContext, id: string) {
  if (id === 'origin') return ctx
  const lab = await readLabManifest(ctx.home, id)
  if (lab.source.profileName !== ctx.profileName) throw new UsageError('Profile mismatch')
  return { ...ctx, home: labHomeDir(ctx.home, id) }
}
