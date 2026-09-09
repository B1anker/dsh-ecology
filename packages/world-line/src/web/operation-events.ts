import type { WorldEvent } from '../domain/insight-types.js'
import { redactText } from '../domain/redaction.js'
import type { PromotionJournalEntry } from '../lab/journal.js'
import type { LabManifest } from '../lab/manifest.js'

/** Group only snapshots explicitly linked by a lab or transaction, never by time proximity. */
export function projectOperations(
  events: WorldEvent[],
  labs: LabManifest[],
  journal: PromotionJournalEntry[],
) {
  const entries = [...new Map(journal.map((entry) => [entry.id, entry])).values()]
  for (const lab of labs) {
    if (lab.purpose === 'mirror') continue
    const transactions = entries
      .filter((entry) => entry.labId === lab.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const latest = transactions.at(-1)
    const restore = events.find(
      (event) => event.kind === 'restore' && event.id === `${latest?.id}:restored`,
    )
    const steps = lab.plan.filter((step) =>
      ['add', 'update', 'remove', 'config-apply'].includes(step.action),
    )
    if (!restore && !steps.length) continue
    const lineId = lab.source.parentLabId ?? 'origin'
    const ids = new Set(
      [
        lab.source.baselineSnapshotId,
        ...transactions.flatMap((entry) => [entry.preSnapshot, entry.afterSnapshot]),
      ].filter(Boolean),
    )
    const children = events.filter(
      (event) => event.lineId === lineId && event.kind === 'snapshot' && ids.has(event.snapshotId),
    )
    const outcome =
      latest?.outcome === 'committed'
        ? '已应用'
        : latest?.outcome === 'committed-restart-failed'
          ? '已应用 · 重启未确认'
          : latest
            ? '应用失败 · 已回退'
            : lab.state === 'failed'
              ? '验证未通过'
              : '待应用'
    const title = steps
      .map((step) => {
        const action = { add: '安装', update: '更新', remove: '卸载', 'config-apply': '修改配置' }[
          step.action
        ]
        const suffix =
          step.id && step.spec?.startsWith(`${step.id}@`) ? step.spec.slice(step.id.length + 1) : ''
        const version =
          suffix && /^[\w.*^~<>=| -]+$/.test(suffix)
            ? /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(suffix)
              ? suffix
              : `${suffix}（请求版本）`
            : '版本未记录'
        return `${action} ${redactText(step.id ?? '插件')}${step.action === 'config-apply' ? '' : ` ${version}`}`
      })
      .join('；')
    const event: WorldEvent = restore ?? {
      id: `${lab.id}:operation`,
      lineId,
      at:
        children.find((child) => child.snapshotId === latest?.afterSnapshot)?.at ??
        lab.lastRun?.finishedAt ??
        lab.createdAt,
      kind: 'operation',
      actionLabel:
        steps.length === 1
          ? { add: '安装插件', update: '更新插件', remove: '卸载插件', 'config-apply': '修改配置' }[
              steps[0]!.action
            ]
          : '修改插件',
      packageLabel: title.replace(/^(安装|更新|卸载|修改配置) /, ''),
      statusLabel: outcome === '已应用' ? '已完成' : outcome === '待应用' ? '等待确认' : outcome,
      title: `${title} · ${outcome}`,
      detail: latest?.reviewAcceptance
        ? '部分功能未验证，你选择了继续。'
        : latest?.outcome === 'rolled-back'
          ? '未能完成，已恢复原配置。'
          : lab.lastRun?.ok
            ? '检查通过。'
            : latest?.outcome === 'committed'
              ? ''
              : '请先完成检查。',
    }
    event.childEventIds = children.map((child) => child.id)
    for (const child of children) child.parentEventId = event.id
    if (!restore) events.push(event)
  }
}
