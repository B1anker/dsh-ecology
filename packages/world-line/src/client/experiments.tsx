import { useState } from 'react'
import { Panel } from './panel.js'
import { type Line, label, stateLabel } from './timeline-model.js'

export function Experiments({
  sourceName,
  lines,
  busy,
  expanded,
  close,
  onLocate,
  onCollapse,
  onVerify,
  onReport,
}: {
  sourceName: string
  lines: Line[]
  busy: boolean
  expanded: string | null
  close(): void
  onLocate(id: string): void
  onCollapse(): void
  onVerify(id: string): void
  onReport(id: string): void
}) {
  const [history, setHistory] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(20)
  const pending = (line: Line) => !line.completedAt && line.state !== 'destroyed'
  const matches = lines
    .filter(
      (line) =>
        pending(line) !== history &&
        `${label(line)} ${line.id}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  return (
    <Panel title="验证实验" close={close} className="wl-inspector" aria-label="验证实验">
      <p>来源：{sourceName}</p>
      <p className="wl-muted">实验默认收在这里。定位时只展开一个实验；收起不会删除数据。</p>
      <div className="wl-row-title">
        <button
          className="wl-button"
          aria-pressed={!history}
          onClick={() => {
            setHistory(false)
            setLimit(20)
          }}
        >
          待处理 {lines.filter(pending).length}
        </button>
        <button
          className="wl-button"
          aria-pressed={history}
          onClick={() => {
            setHistory(true)
            setLimit(20)
          }}
        >
          历史 {lines.filter((line) => !pending(line)).length}
        </button>
      </div>
      <input
        className="wl-experiment-search"
        aria-label="搜索实验"
        placeholder="搜索插件名称或实验 ID"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setLimit(20)
        }}
      />
      {expanded && (
        <button className="wl-button" onClick={onCollapse}>
          收起画布中的实验
        </button>
      )}
      {matches.length === 0 && (
        <p className="wl-muted">
          {query ? '没有匹配的实验' : history ? '暂无历史实验' : '暂无待处理实验'}
        </p>
      )}
      {matches.slice(0, limit).map((line) => (
        <article className="wl-event-detail" key={line.id}>
          <strong>{label(line)}</strong>
          <span>{line.completedAt ? '已合入' : stateLabel(line.state)}</span>
          <time>{new Date(line.createdAt).toLocaleString()}</time>
          <div className="wl-experiment-actions">
            <button
              className="wl-button"
              onClick={() => onLocate(line.id)}
              aria-pressed={expanded === line.id}
            >
              在画布中定位
            </button>
            {pending(line) && (
              <button className="wl-button" disabled={busy} onClick={() => onVerify(line.id)}>
                登录后重验
              </button>
            )}
            <button className="wl-button" disabled={busy} onClick={() => onReport(line.id)}>
              诊断报告
            </button>
          </div>
        </article>
      ))}
      {matches.length > limit && (
        <button className="wl-button" onClick={() => setLimit(limit + 20)}>
          再显示 20 条（剩余 {matches.length - limit}）
        </button>
      )}
    </Panel>
  )
}
