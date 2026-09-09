import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { ArrowsLeftRight } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
import { Camera } from '@phosphor-icons/react/dist/csr/Camera'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { FileText } from '@phosphor-icons/react/dist/csr/FileText'
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch'
import { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple'
import { useEffect, useState } from 'react'
import type { SnapshotDetail, WorldComparison, WorldEvent } from '../domain/insight-types.js'
import { Panel } from './panel.js'
import { Select } from './select.js'
import { type Line, label } from './timeline-model.js'

export type InspectorState = { type: 'history'; id: string; eventId?: string } | { type: 'compare' }
const date = (at: string) => new Date(at).toLocaleString('zh-CN')
const status = (value: string) =>
  ({ added: '新增', removed: '移除', changed: '变化' })[value] ?? value
export function Inspector({
  state,
  lines,
  events,
  comparisonIds,
  onComparisonIds,
  onEvent,
  onFork,
  onSnapshot,
  onPromote,
  onReport,
  onRestore,
  close,
  api,
  busy,
}: {
  state: InspectorState
  lines: Line[]
  events: WorldEvent[]
  comparisonIds: string[]
  onComparisonIds(ids: string[]): void
  onEvent(event: WorldEvent): void
  onFork(id: string, at?: number, snapshotId?: string): void
  onSnapshot(id: string): void
  onPromote(id: string): void
  onReport(id: string): void
  onRestore(id: string, snapshotId: string): void
  close(): void
  api(body: unknown, signal?: AbortSignal): Promise<any>
  busy: boolean
}) {
  const [result, setResult] = useState<WorldComparison | null>(null)
  const [detail, setDetail] = useState<SnapshotDetail | null>(null)
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0)
  const event =
    state.type === 'history' ? events.find((item) => item.id === state.eventId) : undefined
  const snapshotId = event?.snapshotId
  const id = state.type === 'history' ? state.id : ''
  const from = comparisonIds[0] ?? '',
    to = comparisonIds[1] ?? ''
  useEffect(() => {
    const controller = new AbortController()
    setResult(null)
    setDetail(null)
    setError('')
    setLoading(false)
    const body =
      state.type === 'compare'
        ? from && to && from !== to
          ? { action: 'compare', from, to }
          : null
        : snapshotId
          ? { action: 'snapshot-detail', id, snapshotId }
          : null
    if (body) {
      setLoading(true)
      void api(body, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) {
            if (body.action === 'compare') setResult(value)
            else setDetail(value)
          }
          return undefined
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }
    return () => controller.abort()
  }, [state.type, id, snapshotId, from, to, revision, api])
  const line = lines.find((item) => item.id === id)
  const history = events
    .filter((item) => item.lineId === id)
    .toSorted((a, b) => b.at.localeCompare(a.at))
  return (
    <Panel
      title={state.type === 'compare' ? '两种可能，逐项对照' : line ? label(line) : '世界线事件'}
      close={close}
      className="wl-inspector"
      aria-label={state.type === 'compare' ? '双线对比' : '世界线事件'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      {state.type === 'compare' ? (
        <>
          <p className="wl-muted">选择两条线比较当前状态，也可以 Shift + 单击图中的世界线。</p>
          <div className="wl-compare-selects">
            {[0, 1].map((index) => (
              <Select
                key={index}
                label={index === 0 ? '基准世界线' : '目标世界线'}
                value={comparisonIds[index] ?? ''}
                disabled={busy}
                onChange={(value) => {
                  const next = [...comparisonIds]
                  next[index] = value
                  onComparisonIds(next)
                }}
                options={[
                  { value: '', label: '选择世界线' },
                  ...lines
                    .filter((item) => item.kind !== 'verification')
                    .map((item) => ({
                      value: item.id,
                      label: label(item),
                      disabled: comparisonIds[1 - index] === item.id,
                    })),
                ]}
              />
            ))}
          </div>
          <div className="wl-toolbar">
            <button
              className="wl-button"
              disabled={!from || !to || loading}
              onClick={() => onComparisonIds([to, from])}
            >
              <ArrowsLeftRight size={15} />
              交换方向
            </button>
            <button
              className="wl-button"
              disabled={!from || !to || loading}
              onClick={() => setRevision((v) => v + 1)}
            >
              重新比较
            </button>
          </div>
          {(!from || !to) && (
            <p className="wl-insight-empty">选好另一条世界线，看看分歧发生在哪里。</p>
          )}
          {result && (
            <>
              <div className="wl-insight-summary">
                <strong>{result.dependencies.length}</strong> 个插件差异{' '}
                <strong>{result.patches.length}</strong> 处配置项变化
              </div>
              <p className="wl-muted">读取于 {date(result.at)} · 从左侧基准看右侧目标</p>
              <h3>插件变化</h3>
              {result.dependencies.length ? (
                result.dependencies.map((dep) => (
                  <div className="wl-diff-row" key={dep.name}>
                    <strong>{dep.name}</strong>
                    <span className="wl-badge">{status(dep.status)}</span>
                    <p>
                      {dep.before} → {dep.after}
                    </p>
                    {!!dep.changes?.length && <p>{dep.changes.join('、')}不同</p>}
                  </div>
                ))
              ) : (
                <p className="wl-muted">插件组成与版本一致。</p>
              )}
              <h3>配置与文件</h3>
              {result.patches.map((patch, i) => (
                <div className="wl-diff-row" key={`${patch.file}-${i}`}>
                  <strong>{patch.file === 'home' ? '全局配置' : 'Profile 配置'}</strong>
                  <span>{status(patch.status)}</span>
                  <p>{patch.key}</p>
                </div>
              ))}
              {result.files.map((file) => (
                <div className="wl-diff-row" key={file.name}>
                  <strong>{file.name}</strong>
                  <span>{status(file.status)}</span>
                </div>
              ))}
              {!result.files.length && !result.patches.length && (
                <p className="wl-muted">纳入比较的配置文件一致。</p>
              )}
              <details>
                <summary>插件组合</summary>
                <p>基准：{result.bundles.before.join(' · ') || '无'}</p>
                <p>目标：{result.bundles.after.join(' · ') || '无'}</p>
              </details>
              {result.warnings.map((warning) => (
                <p key={warning} className="wl-muted">
                  {warning}
                </p>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <div className="wl-toolbar">
            <p className="wl-muted">{history.length} 个记录 · ◆ 快照可分支</p>
            {line?.kind === 'verification' && (
              <>
                <button
                  className="wl-button"
                  disabled={busy || line.verdict !== 'passed'}
                  title={
                    line.verdict === 'passed'
                      ? '将验证结果合回来源环境'
                      : '仅完整验证通过的实验可以合入'
                  }
                  onClick={() => onPromote(id)}
                >
                  <UploadSimple size={15} />
                  Promote
                </button>
                <button className="wl-button" disabled={busy} onClick={() => onReport(id)}>
                  <FileText size={15} />
                  生成报告
                </button>
              </>
            )}
            <button
              className="wl-button"
              disabled={busy || !line || line.state === 'applying'}
              onClick={() => onSnapshot(id)}
            >
              <Camera size={15} />
              保存快照
            </button>
          </div>
          {event && (
            <section className="wl-event-detail">
              <span className="wl-eyebrow">
                {event.kind === 'snapshot' ? 'CHECKPOINT' : 'EVENT'}
              </span>
              <h3>{event.title}</h3>
              <time>{date(event.at)}</time>
              <p>{event.detail}</p>
              {detail && (
                <>
                  <p className="wl-muted">{detail.warnings.join(' ')}</p>
                  <button
                    className="wl-button wl-primary"
                    disabled={busy || !detail.restorable}
                    onClick={() => onFork(id, Date.parse(event.at), detail.id)}
                  >
                    <GitBranch size={15} />
                    从此快照创建世界线
                  </button>
                  <button
                    className="wl-button"
                    disabled={busy || !detail.restorable}
                    title="在验证实验中还原此快照，验证通过后自动合入正式环境"
                    onClick={() => onRestore(id, detail.id)}
                  >
                    <ArrowCounterClockwise size={15} />
                    恢复到此快照
                  </button>
                  <details>
                    <summary>
                      {detail.dependencies.length} 个插件 · {detail.files.length} 份配置
                    </summary>
                    {detail.dependencies.map((dep) => (
                      <p key={dep.name}>
                        {dep.name} <span className="wl-muted">{dep.version}</span>
                      </p>
                    ))}
                    {detail.files.map((file) => (
                      <p key={file.name}>
                        {file.name} · {file.stored ? '已保存' : '未保存'}
                      </p>
                    ))}
                  </details>
                </>
              )}
              {event.kind !== 'snapshot' && (
                <p className="wl-muted">这是事件记录；只有快照节点可以恢复当时的配置。</p>
              )}
            </section>
          )}
          {!history.length && (
            <p className="wl-insight-empty">
              还没有留下快照。保存当前配置，给下一次试验留一个起点。
            </p>
          )}
          <nav aria-label="事件记录" className="wl-event-list">
            {history.map((item) => (
              <button
                key={item.id}
                aria-pressed={event?.id === item.id}
                onClick={() => onEvent(item)}
              >
                <span className="wl-event-symbol" data-kind={item.kind}>
                  {item.kind === 'snapshot' ? '◆' : '○'}
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <time>{date(item.at)}</time>
                </span>
              </button>
            ))}
          </nav>
        </>
      )}
      {loading && (
        <p className="wl-insight-loading" role="status">
          <CircleNotch size={18} className="wl-spin" />
          正在读取真实配置…
        </p>
      )}
      {error && (
        <div className="wl-error" role="alert">
          <p>{error}</p>
          <button className="wl-button" onClick={() => setRevision((v) => v + 1)}>
            重试
          </button>
        </div>
      )}
    </Panel>
  )
}
