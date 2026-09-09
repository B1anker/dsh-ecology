import { type CSSProperties, useState } from 'react'
import type { StorageSize } from '../vault/maintenance.js'

const labels: Record<string, string> = {
  'vault/objects': '快照内容对象',
  'vault/snapshots': '快照记录',
  'vault/secrets': '加密配置',
  reports: '诊断报告',
  jobs: '任务记录',
  merges: '合入准备',
  cache: '共享下载缓存',
  investigations: '排障记录',
  deployments: 'A/B 部署',
  'host-versions': '矩阵宿主安装',
  'upgrade-results': '升级验证结果',
  requests: '提交记录',
  quarantine: '隔离回收区',
  'state.json': '管理状态',
  'labs/.defaults.json': '默认世界线设置',
  'journal.jsonl': '操作日志',
}
const categories = [
  { id: 'labs', label: '世界线与恢复环境', color: 'var(--wl-menu-gold,#edbb16)' },
  { id: 'cache', label: '下载缓存', color: '#a8a58f' },
  { id: 'vault', label: '快照与配置', color: '#d8ccaa' },
  { id: 'work', label: '验证与交付', color: '#7d827c' },
  { id: 'quarantine', label: '隔离回收区', color: '#b69a77' },
  { id: 'other', label: '其他记录', color: '#b9bdba' },
]
export function storageCategory(name: string) {
  if (/^(labs|rescues)\//.test(name) && name !== 'labs/.defaults.json') return 'labs'
  if (name === 'cache') return 'cache'
  if (name.startsWith('vault/')) return 'vault'
  if (name === 'quarantine') return 'quarantine'
  if (
    ['merges', 'deployments', 'host-versions', 'upgrade-results', 'investigations'].includes(name)
  )
    return 'work'
  return 'other'
}
export function storageSize(bytes: number) {
  if (bytes === 0) return '0 B'
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))))
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 2 : 0 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
const percent = (value: number, total: number) => (total ? (value / total) * 100 : 0)
const shareText = (value: number) => (value > 0 && value < 0.1 ? '<0.1%' : `${value.toFixed(1)}%`)

// Embedded storage inspector: composition of the scanned world-line directory, not disk capacity.
// A zero-based share bar plus ranked category/file rows retains tiny groups as exact labels.
export function StorageOverview({
  data,
  names,
  onCleanup,
}: {
  data: StorageSize
  names: Record<string, string>
  onCleanup(): void
}) {
  const [metric, setMetric] = useState<'allocatedBytes' | 'logicalBytes'>('allocatedBytes')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const total = data[metric]
  const rows = Object.entries(data.groups)
    .map(([id, value]) => ({
      id,
      label: names[id] ?? labels[id] ?? id,
      ...value,
      category: storageCategory(id),
    }))
    .sort((a, b) => b[metric] - a[metric] || a.id.localeCompare(b.id))
  const groups = categories
    .map((category) => ({
      ...category,
      bytes: rows
        .filter((row) => row.category === category.id)
        .reduce((sum, row) => sum + row[metric], 0),
      count: rows.filter((row) => row.category === category.id).length,
    }))
    .filter((group) => group.count > 0)
    .sort((a, b) => b.bytes - a.bytes)
  const filtered = rows.filter(
    (row) =>
      (filter === 'all' || row.category === filter) &&
      `${row.label} ${row.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  const visible = expanded ? filtered : filtered.slice(0, 6)
  const metricLabel = metric === 'allocatedBytes' ? '已分配空间' : '文件大小'
  return (
    <section className="wl-storage-overview" aria-label="空间占用可视化">
      <div className="wl-storage-total">
        <small className="wl-storage-kicker" aria-hidden="true">
          WORLD LINE / STORAGE
        </small>
        <span>{metricLabel}</span>
        <strong>{storageSize(total)}</strong>
        <small>世界线管理目录 · {data.files.toLocaleString()} 个文件</small>
        <div className="wl-storage-metric" role="group" aria-label="统计口径">
          {(['allocatedBytes', 'logicalBytes'] as const).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={metric === key}
              onClick={() => setMetric(key)}
            >
              {key === 'allocatedBytes' ? '已分配空间' : '文件大小'}
            </button>
          ))}
        </div>
      </div>
      {data.warnings.length > 0 && (
        <p className="wl-error">部分目录未能完整统计，以下分布仅包含已读取的数据。</p>
      )}
      {total > 0 ? (
        <>
          <div className="wl-storage-section-title">
            <strong>空间分布</strong>
            <small>占当前统计总量</small>
          </div>
          <div className="wl-storage-composition" aria-hidden="true">
            {groups.map((group) => (
              <span
                key={group.id}
                style={{ width: `${percent(group.bytes, total)}%`, background: group.color }}
              />
            ))}
          </div>
          <div className="wl-storage-categories" aria-label="按类别筛选">
            {groups.map((group) => (
              <button
                type="button"
                key={group.id}
                aria-pressed={filter === group.id}
                onClick={() => {
                  setFilter(filter === group.id ? 'all' : group.id)
                  setExpanded(false)
                }}
                style={{ '--wl-storage-color': group.color } as CSSProperties}
              >
                <i aria-hidden="true" />
                <span>{group.label}</span>
                <strong>{storageSize(group.bytes)}</strong>
                <small>{shareText(percent(group.bytes, total))}</small>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="wl-muted">当前口径下暂无空间占用。</p>
      )}
      <div className="wl-storage-section-title">
        <strong>占用排行</strong>
        {filter !== 'all' ? (
          <button
            type="button"
            className="wl-button"
            onClick={() => {
              setFilter('all')
              setExpanded(false)
            }}
          >
            显示全部类别
          </button>
        ) : (
          <small>从大到小</small>
        )}
      </div>
      <input
        type="search"
        aria-label="搜索空间占用明细"
        placeholder="搜索世界线或目录…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setExpanded(false)
        }}
      />
      <ol className="wl-storage-ranking">
        {visible.map((row) => (
          <li
            key={row.id}
            style={
              {
                '--wl-storage-color': categories.find((group) => group.id === row.category)!.color,
              } as CSSProperties
            }
          >
            <div className="wl-storage-row-title">
              <span title={row.label}>{row.label}</span>
              <strong>{storageSize(row[metric])}</strong>
            </div>
            <div className="wl-storage-bar" aria-hidden="true">
              <span style={{ width: `${percent(row[metric], total)}%` }} />
            </div>
            <div className="wl-storage-row-meta">
              <span>
                {row.files.toLocaleString()} 个文件 · {shareText(percent(row[metric], total))}
              </span>
              <span>
                {metric === 'allocatedBytes' ? '文件' : '已分配'}{' '}
                {storageSize(row[metric === 'allocatedBytes' ? 'logicalBytes' : 'allocatedBytes'])}
              </span>
            </div>
            <small className="wl-storage-path" title={row.id}>
              {row.id}
            </small>
          </li>
        ))}
      </ol>
      {filtered.length === 0 && <p className="wl-muted">没有匹配的目录。</p>}
      {filtered.length > 6 && (
        <button type="button" className="wl-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起明细' : `查看全部 ${filtered.length} 项`}
        </button>
      )}
      <div className="wl-storage-footnote">
        <span>统计于 {new Date(data.at).toLocaleString()} · 缓存 1 分钟</span>
        <p>已分配空间不等于可释放空间。清理前请先查看预览。</p>
        <button type="button" className="wl-button" onClick={onCleanup}>
          查看安全清理
        </button>
        <details>
          <summary>统计说明</summary>
          <p>
            文件大小为内容的逻辑大小；已分配空间按文件系统分配块统计。不跟随符号链接，硬链接按 inode
            去重，因此共享文件只归入首次扫描到的目录。APFS
            克隆与共享块会影响实际释放量。此处不代表整块磁盘容量。
          </p>
        </details>
      </div>
    </section>
  )
}
