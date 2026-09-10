import { useEffect, useState } from 'react'
import type { StorageSize } from '../vault/maintenance.js'
import type { ApiFn } from './api-types.js'
import { useActionRunner, useApiQuery } from './async.js'
import { ErrorText } from './error-text.js'
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
  api: ApiFn
}) {
  const [topic, setTopic] = useState('usage')
  const [plan, setPlan] = useState<any>(null),
    [kind, setKind] = useState(''),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [cacheBusy, setCacheBusy] = useState(false),
    [record, setRecord] = useState(''),
    [messages, setMessages] = useState<Record<string, string>>({})
  const [legacy, setLegacy] = useState(''),
    [cacheConfirmed, setCacheConfirmed] = useState(false)
  const { pending, error: actionError, setError: setActionError, run } = useActionRunner()
  const busy = cacheBusy || !!pending
  const recordsQuery = useApiQuery<{ id: string; at: string; remaining: number }[]>(
    api,
    topic === 'restore' ? { action: 'gc-records', id } : null,
    [id, topic],
    { fallback: '读取失败', keepData: true },
  )
  const records = recordsQuery.data ?? []
  const recordsError = recordsQuery.error
  const recordsLoading =
    recordsQuery.loading || (topic === 'restore' && !recordsQuery.data && !recordsQuery.error)
  const storageQuery = useApiQuery<StorageSize>(api, { action: 'storage', id }, [id], {
    fallback: '读取失败',
    keepData: true,
  })
  const data = storageQuery.data
  const error = errors[topic] || actionError
  const message = messages[topic]
  const setError = (text: string, target = topic) =>
    setErrors((current) => ({ ...current, [target]: text }))
  const setMessage = (text: string) => setMessages((current) => ({ ...current, [topic]: text }))
  useEffect(() => {
    if (storageQuery.error) setErrors((current) => ({ ...current, usage: storageQuery.error }))
  }, [storageQuery.error])
  const changeTopic = (next: string) => {
    setErrors({})
    setMessages({})
    setActionError('')
    setTopic(next)
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
      {error && <ErrorText message={error} />}
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
            onClick={() => {
              void run(
                '处理中…',
                () => api({ action: 'cache-migrate', id: legacy }),
                (r) => {
                  if (r) setMessage(`新实例 ${r.id}。${r.note ?? '已使用共享缓存'}`)
                },
                '操作失败',
              )
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
              setCacheBusy(true)
              try {
                const r = await api({ action: 'cache-prune', runtimeStopped: true })
                setMessage(r.note)
              } catch (e) {
                setError(String(e))
              } finally {
                setCacheBusy(false)
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
      <div hidden={topic !== 'cleanup'} className="wl-maintenance-goals">
        {[
          [
            'storage-prune',
            '预览旧快照清理',
            '按保留策略筛选旧快照。仍被恢复流程使用的快照会受到保护。',
          ],
          ['gc', '预览对象回收', '隔离已不被任何快照引用的文件对象；隔离后可在找回对象中恢复。'],
        ].map(([action, title, description]) => (
          <button
            className="wl-goal-option"
            key={action}
            disabled={busy}
            onClick={() => {
              setPlan(null)
              setKind(action!)
              void run(
                '处理中…',
                () => api({ action: `${action}-preview`, id }),
                (result) => setPlan(result),
                '操作失败',
              )
            }}
          >
            <strong>{title}</strong>
            <span>{description}</span>
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
            onClick={() => {
              void run(
                '处理中…',
                () => api({ action: `${kind}-apply`, id, revision: plan.revision }),
                (result) => {
                  if (!result) return
                  setMessage(result.note ?? `已清理 ${result.removed.length} 份快照`)
                  if (result.id) {
                    setRecord(result.id)
                    recordsQuery.reload()
                  }
                  setPlan(null)
                },
                '操作失败',
              )
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
          onClick={() => recordsQuery.reload()}
        >
          {recordsError ? '重新加载回收记录' : '刷新回收记录'}
        </button>
        <details>
          <summary>按记录编号找回（高级）</summary>
          <label>
            回收记录编号
            <input value={record} onChange={(e) => setRecord(e.target.value)} placeholder="gc-…" />
          </label>
        </details>
        <button
          className="wl-button"
          disabled={busy || !/^gc-\d+-[a-f0-9]{8}$/.test(record)}
          onClick={() => {
            void run(
              '处理中…',
              () => api({ action: 'gc-restore', id, recordId: record }),
              (r) => {
                if (r) {
                  setMessage(`已恢复 ${r.restored} 个对象`)
                  recordsQuery.reload()
                }
              },
              '操作失败',
            )
          }}
        >
          恢复对象
        </button>
        <details>
          <summary>永久删除隔离对象（高级）</summary>
          <p className="wl-muted">
            使用 CLI：vault purge 记录ID --yes。服务端会再次检查七天保留期和快照引用。
          </p>
        </details>
      </section>
    </>
  )
}
