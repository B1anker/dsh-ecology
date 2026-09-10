import { runLabStart } from '../commands/lab-service.js'
import { runRestoreCommand } from '../commands/restore.js'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { redactText } from '../domain/redaction.js'
import { withOperations } from '../fs/operation.js'
import { sourceContext } from '../lab/source.js'
import type { JobHandle } from '../web/jobs.js'
import { nextTrial, readInvestigation, saveInvestigation, type Verdict } from './bisect.js'

export async function runInvestigation(
  ctx: CliContext,
  id: string,
  handle: JobHandle,
  automatic = false,
) {
  return withOperations(
    [ctx.home],
    `investigation:${id}`,
    async () => {
      const s = await readInvestigation(ctx, id)
      if (s.status === 'running')
        throw new UsageError('上次试验未结算，请先检查关联实验，再明确将本步标为跳过')
      if (s.status === 'review') throw new UsageError('请先判断上一轮结果')
      for (let count = 0; count < 10000; count++) {
        const trial = nextTrial(s)
        if (!trial) {
          await saveInvestigation(ctx, s)
          return { ...s, ok: s.status === 'complete' }
        }
        s.active = trial
        s.status = 'running'
        await saveInvestigation(ctx, s)
        handle.setPhase(
          `第 ${s.trials.length + 1} 次试验：${s.kind === 'time' ? trial.snapshotId : `保留 ${trial.plugins?.length} 个非核心插件`}`,
        )
        let preparationError: string | undefined
        try {
          const source = await sourceContext(ctx, s.sourceId)
          const result = await runRestoreCommand(source, {
            manager: ctx,
            sourceId: s.sourceId,
            snapshotId: trial.snapshotId ?? s.baseline,
            keep: true,
            removePlugins:
              s.kind === 'plugins'
                ? s.plugins.filter((p) => !trial.plugins!.includes(p))
                : undefined,
            onLabCreated: async (labId) => {
              trial.labId = labId
              handle.setLabId(labId)
              await saveInvestigation(ctx, s)
            },
            onProbe: (probe) => {
              handle.pushProbe(probe)
              if (
                probe.status === 'fail' &&
                ['dependency-install', 'plugin-add', 'plugin-update', 'plugin-remove'].includes(
                  probe.check,
                )
              ) {
                preparationError ??= redactText(probe.detail ?? probe.label ?? probe.check)
              }
            },
          })
          if (preparationError) trial.error = `实验环境准备失败：${preparationError}`
          trial.suggested =
            trial.error || result.clientGate === 'inconclusive' || result.clientGate === 'skipped'
              ? 'skip'
              : result.ok
                ? 'good'
                : 'bad'
        } catch (e) {
          trial.error = redactText(e instanceof Error ? e.message : String(e))
          trial.suggested = 'skip'
        }
        s.status = 'review'
        await saveInvestigation(ctx, s)
        // Preparation errors are not evidence against a plugin. Stop automatic trials
        // and retain this trial for review instead of repeatedly creating broken labs.
        if (trial.error || !automatic)
          return { ...s, ok: !trial.error && trial.suggested !== 'skip' }
        trial.verdict = trial.suggested as Verdict
        s.trials.push(trial)
        delete s.active
        s.status = 'ready'
        await saveInvestigation(ctx, s)
      }
      throw new UsageError('试验次数达到安全上限，请检查排障记录')
    },
    ctx.breakStaleLock,
  )
}
export async function skipInterruptedTrial(ctx: CliContext, id: string) {
  return withOperations(
    [ctx.home],
    `investigation:${id}`,
    async () => {
      const s = await readInvestigation(ctx, id)
      if (s.status !== 'running' || !s.active) throw new UsageError('没有中断试验')
      s.active.verdict = 'skip'
      s.active.error = '用户确认跳过未结算试验；不重放命令'
      s.trials.push(s.active)
      delete s.active
      s.status = 'ready'
      await saveInvestigation(ctx, s)
      return s
    },
    ctx.breakStaleLock,
  )
}

export async function previewInvestigation(ctx: CliContext, id: string) {
  return withOperations(
    [ctx.home],
    `investigation:${id}`,
    async () => {
      const s = await readInvestigation(ctx, id)
      if (s.status !== 'review' || !s.active?.labId) throw new UsageError('请先完成本步验证')
      const result = await runLabStart(
        ctx,
        s.active.manualLabId ? { id: s.active.manualLabId } : { new: true, from: s.active.labId },
      )
      s.active.manualLabId = result.id
      await saveInvestigation(ctx, s)
      return result
    },
    ctx.breakStaleLock,
  )
}
