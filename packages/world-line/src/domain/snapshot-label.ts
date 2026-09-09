/** Translate generated labels at the presentation boundary; keep user labels intact. */
export function snapshotLabel(label?: string | null): string {
  if (!label) return '配置快照'
  if (label.startsWith('合入前：')) return `合入 ${label.slice(4)} 前的备份`
  if (label.startsWith('pre-promote: lab lab-')) return '应用变更前 · 自动备份'
  if (label.startsWith('post-promote: lab lab-')) return '应用变更后 · 已保存'
  const action = /^验证前 · (add|remove|update|config)$/.exec(label)?.[1]
  if (action)
    return (
      {
        add: '安装插件前 · 自动备份',
        remove: '卸载插件前 · 自动备份',
        update: '更新插件前 · 自动备份',
        config: '修改配置前 · 自动备份',
      } as Record<string, string>
    )[action]!
  return label
}
