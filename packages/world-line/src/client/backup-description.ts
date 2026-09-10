import type { WorldEvent } from '../domain/insight-types.js'

/** Only explicit snapshot links can identify an operation; timestamps and names cannot. */
export function backupDescription(point: WorldEvent, events: WorldEvent[]) {
  const operations = events.filter(
    (event) =>
      event.lineId === point.lineId &&
      ['operation', 'merge'].includes(event.kind) &&
      (event.childEventIds?.includes(point.id) ||
        events.some(
          (child) =>
            child.lineId === point.lineId &&
            child.snapshotId === point.snapshotId &&
            child.parentEventId === event.id,
        )),
  )
  const name = point.title
  const mergeOperation =
    operations.length === 1 && operations[0]!.kind === 'merge' ? operations[0] : undefined
  const mergeSource = mergeOperation?.title.split(' → ')[0] || '来源未记录'
  if (operations.length)
    return {
      label:
        operations.length === 1
          ? operations[0]!.kind === 'merge'
            ? `合入变更 · ${mergeSource} · ${operations[0]!.packages ? `${operations[0]!.packages!.length}个变更` : '变更数量未记录'}`
            : `${operations[0]!.actionLabel ?? '插件操作'} ${operations[0]!.packageLabel ?? ''} · 环境备份`
          : `${operations.length} 项插件操作 · 环境备份`,
      explanation: '这是关联操作保存的环境内容，操作是否完成以任务结果为准。',
      operations,
    }
  if (['插件排障基线', '开始排查插件前的备份'].includes(name))
    return {
      label: '插件排查 · 自动保存的环境',
      explanation: '系统为复现问题保存的插件与配置，不代表已经验证可用。',
      operations,
    }
  if (/^(安装|卸载|更新)插件前/.test(name))
    return {
      label: `${name.startsWith('安装') ? '插件安装' : name.startsWith('卸载') ? '插件卸载' : '插件更新'} · 未记录插件和版本`,
      explanation:
        '这份旧备份没有关联的插件操作信息。下方列出的是备份内的插件，不等于本次安装或更新的目标。',
      operations,
    }
  const merge = /^合入 (.+) 前的备份$/.exec(name)
  if (merge)
    return {
      label: `合入变更 · ${merge[1]} · 变更数量未记录`,
      explanation: '保存了合入操作使用的环境内容，不表示合入已完成。',
      operations,
    }
  if (/^(应用变更|修改配置)(前|后)/.test(name))
    return {
      label: '配置变更 · 环境备份',
      explanation: '保存的插件与配置，操作结果请查看关联任务。',
      operations,
    }
  return {
    label: `命名备份 · ${name || '未命名'}`,
    explanation: `“${name || '未命名'}”是保存时的名称，不是验证结果。请按实际使用情况选择。`,
    operations,
  }
}
