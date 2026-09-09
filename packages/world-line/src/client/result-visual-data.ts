export type ChangeGroups = Record<'dependencies' | 'files' | 'patches', { status: string }[]>
export const changeKinds = [
  { id: 'added', label: '新增', mark: '+', color: 'var(--wl-menu-gold,#edbb16)' },
  { id: 'changed', label: '变更', mark: '~', color: '#b7a778' },
  { id: 'removed', label: '移除', mark: '−', color: '#929590' },
] as const
export function changeCounts(diff: ChangeGroups) {
  return (
    [
      { key: 'dependencies', label: '插件' },
      { key: 'files', label: '文件' },
      { key: 'patches', label: '配置项' },
    ] as const
  ).map((group) => ({
    ...group,
    values: changeKinds.map(
      (kind) => diff[group.key].filter((entry) => entry.status === kind.id).length,
    ),
  }))
}
export function retentionCounts(total: number, deleteIds: string[]) {
  const removed = deleteIds.length,
    kept = Math.max(0, total - removed)
  return {
    total,
    removed,
    kept,
    keptPercent: total ? (kept / total) * 100 : 0,
    removedPercent: total ? (removed / total) * 100 : 0,
  }
}
export function browserVerdict(value?: string): {
  state: 'pass' | 'fail' | 'unknown'
  text: string
} {
  return {
    state: value === 'pass' ? 'pass' : value === 'fail' ? 'fail' : 'unknown',
    text:
      (
        { pass: '通过', fail: '失败', inconclusive: '待判断', skipped: '未执行' } as Record<
          string,
          string
        >
      )[value ?? ''] ?? '未记录',
  }
}
