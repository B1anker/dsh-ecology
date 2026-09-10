import { useEffect, useState } from 'react'
import type { StorageSize } from '../vault/maintenance.js'
import { HudSelect, HudTabs } from './hud-controls.js'
import { CleanupSummary } from './result-visuals.js'
import { StorageOverview } from './storage-overview.js'

export function StoragePanel({
  id,
  api,
  names = {},
}: {
  id: string
  names?: Record<string, string>
  api(body: unknown): Promise<any>
}) {
  const [topic, setTopic] = useState('usage')
  const [data, setData] = useState<StorageSize | null>(null),
    [plan, setPlan] = useState<any>(null),
    [kind, setKind] = useState(''),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [record, setRecord] = useState(''),
    [messages, setMessages] = useState<Record<string, string>>({})
  const [legacy, setLegacy] = useState(''),
    [cacheConfirmed, setCacheConfirmed] = useState(false)
  const [records, setRecords] = useState<{ id: string; at: string; remaining: number }[]>([])
  const [recordsLoading, setRecordsLoading] = useState(true)
  const [recordsError, setRecordsError] = useState('')
  const [recordsRevision, setRecordsRevision] = useState(0)
  const error = errors[topic]
  const message = messages[topic]
  const setError = (text: string, target = topic) =>
    setErrors((current) => ({ ...current, [target]: text }))
  const setMessage = (text: string) => setMessages((current) => ({ ...current, [topic]: text }))
  const changeTopic = (next: string) => {
    setErrors({})
    setMessages({})
    setTopic(next)
  }
  useEffect(() => {
    if (topic !== 'restore') return
    let active = true
    setRecordsLoading(true)
    setRecordsError('')
    void api({ action: 'gc-records', id })
      .then((result) => {
        if (active) setRecords(result)
      })
      .catch((e) => {
        if (active) setRecordsError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (active) setRecordsLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, id, topic, recordsRevision])
  useEffect(() => {
    let active = true
    void api({ action: 'storage', id })
      .then((x) => {
        if (active) setData(x)
      })
      .catch((e) => {
        if (active) setError(e.message, 'usage')
      })
    return () => {
      active = false
    }
  }, [api, id])
  const request = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setError('')
    try {
      return await api({ action, id, ...extra })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <HudTabs
        value={topic}
        onChange={changeTopic}
        label="存储功能"
        items={[
          { id: 'usage', title: '空间概览' },
          { id: 'cleanup', title: '安全清理' },
          { id: 'cache', title: '下载缓存' },
          { id: 'restore', title: '找回对象' },
        ]}
      />
      <p hidden={topic === 'usage'} className="wl-muted">
        {topic === 'cleanup'
          ? '先预览将清理的内容，再确认执行。占用空间不等于最终可释放空间。'
          : topic === 'cache'
            ? '下载缓存可供后续安装复用。清理后，需要时会重新下载。'
            : '选择已回收的对象，检查内容后再恢复。'}
      </p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {topic === 'cache' && id === 'origin' && (
        <section className="wl-event-detail">
          <h3>下载缓存</h3>
          <p>迁移会创建独立副本，旧实例保留供核对。清理前须停止实例和安装器。</p>
          <input
            aria-label="旧实验编号"
            value={legacy}
            onChange={(e) => setLegacy(e.target.value)}
            placeholder="lab-…"
          />
          <button
            className="wl-button"
            disabled={busy || !legacy}
            onClick={async () => {
              const r = await request('cache-migrate', { id: legacy })
              if (r) setMessage(`新实例 ${r.id}。${r.note ?? '已使用共享缓存'}`)
            }}
          >
            创建共享缓存副本
          </button>
          <label>
            <input
              type="checkbox"
              checked={cacheConfirmed}
              onChange={(e) => setCacheConfirmed(e.target.checked)}
            />
            确认安装器和实例已停止，允许 pnpm 清理下载缓存
          </label>
          <button
            className="wl-button"
            disabled={busy || !cacheConfirmed}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api({ action: 'cache-prune', runtimeStopped: true })
                setMessage(r.note)
              } catch (e) {
                setError(String(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            清理共享缓存
          </button>
        </section>
      )}
      {topic === 'usage' &&
        (data ? (
          <>
            <StorageOverview data={data} names={names} onCleanup={() => changeTopic('cleanup')} />
            {data.warnings.map((w, i) => (
              <p key={i} className="wl-error">
                {w}
              </p>
            ))}
          </>
        ) : (
          <p>正在统计…</p>
        ))}
      <div hidden={topic !== 'cleanup'} className="wl-flow-actions-row">
        {[
          ['storage-prune', '预览快照保留策略'],
          ['gc', '预览对象回收'],
        ].map(([action, title]) => (
          <button
            className="wl-button"
            key={action}
            disabled={busy}
            onClick={async () => {
              setPlan(null)
              setKind(action!)
              setPlan(await request(`${action}-preview`))
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {topic === 'cleanup' && plan && (
        <section className="wl-event-detail wl-storage-preview">
          <h3>{kind === 'gc' ? '待隔离对象' : '快照清理预览'}</h3>
          <CleanupSummary plan={plan} kind={kind} />
          <button
            className="wl-button"
            disabled={busy || !(kind === 'gc' ? plan.objects.length : plan.delete.length)}
            onClick={async () => {
              const result = await request(`${kind}-apply`, { revision: plan.revision })
              if (result) {
                setMessage(result.note ?? `已清理 ${result.removed.length} 份快照`)
                if (result.id) {
                  setRecord(result.id)
                  setRecordsRevision((value) => value + 1)
                }
                setPlan(null)
              }
            }}
          >
            {kind === 'gc' ? '确认隔离这些对象' : '确认删除这些快照'}
          </button>
          <button className="wl-button" onClick={() => setPlan(null)}>
            取消
          </button>
        </section>
      )}
      <section hidden={topic !== 'restore'} className="wl-event-detail">
        <h3>恢复隔离对象</h3>
        {recordsLoading ? (
          <p role="status">正在加载回收记录…</p>
        ) : recordsError ? (
          <p className="wl-error" role="alert">
            回收记录加载失败：{recordsError}
          </p>
        ) : records.length === 0 ? (
          <p className="wl-muted" role="status">
            暂无回收记录。预览不会生成记录，执行对象隔离后才会显示在这里。
          </p>
        ) : (
          <label>
            选择回收记录
            <HudSelect value={record} onChange={(e) => setRecord(e.target.value)}>
              <option value="">请选择</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.at).toLocaleString()} · {r.remaining} 个对象 · {r.id}
                </option>
              ))}
            </HudSelect>
          </label>
        )}
        <button
          className="wl-button"
          disabled={recordsLoading}
          onClick={() => setRecordsRevision((value) => value + 1)}
        >
          {recordsError ? '重新加载回收记录' : '刷新回收记录'}
        </button>
        <label>
          回收记录 ID
          <input value={record} onChange={(e) => setRecord(e.target.value)} placeholder="gc-…" />
        </label>
        <button
          className="wl-button"
          disabled={busy || !/^gc-\d+-[a-f0-9]{8}$/.test(record)}
          onClick={async () => {
            const r = await request('gc-restore', { recordId: record })
            if (r) {
              setMessage(`已恢复 ${r.restored} 个对象`)
              setRecordsRevision((value) => value + 1)
            }
          }}
        >
          恢复对象
        </button>
        <p className="wl-muted">
          永久删除使用 CLI：vault purge 记录ID --yes。服务端会再次检查七天保留期和快照引用。
        </p>
      </section>
    </>
  )
}
