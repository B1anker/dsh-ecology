import { useEffect, useState } from 'react'
import type { StorageSize } from '../vault/maintenance.js'
import { HudSelect, HudTabs } from './hud-controls.js'

const size = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
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
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [record, setRecord] = useState(''),
    [message, setMessage] = useState('')
  const [legacy, setLegacy] = useState(''),
    [cacheConfirmed, setCacheConfirmed] = useState(false)
  const [records, setRecords] = useState<{ id: string; at: string; remaining: number }[]>([])
  useEffect(() => {
    let active = true
    void api({ action: 'gc-records', id })
      .then((x) => {
        if (active) setRecords(x)
        return undefined
      })
      .catch(() => {})
    void api({ action: 'storage', id })
      .then((x) => {
        if (active) setData(x)
      })
      .catch((e) => {
        if (active) setError(e.message)
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
        onChange={setTopic}
        label="存储功能"
        items={[
          { id: 'usage', title: '空间概览' },
          { id: 'cleanup', title: '安全清理' },
          { id: 'cache', title: '下载缓存' },
          { id: 'restore', title: '找回对象' },
        ]}
      />
      <p className="wl-muted">
        统计不跟随符号链接，硬链接按 inode 去重。逻辑大小与已分配空间不等于 APFS
        上最终可释放空间；统计缓存一分钟。
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
            <p>
              逻辑大小 {size(data.logicalBytes)} · 已分配 {size(data.allocatedBytes)} · {data.files}{' '}
              个文件
            </p>
            <small>统计时间：{new Date(data.at).toLocaleString()}</small>
            {Object.entries(data.groups).map(([name, g]) => (
              <article className="wl-event-detail" key={name}>
                <strong>
                  {names[name] ??
                    (
                      {
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
                        requests: '提交幂等记录',
                        quarantine: '隔离回收区',
                        'state.json': '管理状态',
                        'labs/.defaults.json': '默认世界线设置',
                      } as Record<string, string>
                    )[name] ??
                    name}
                </strong>
                {names[name] && <small className="wl-muted">{name}</small>}
                <span>
                  {size(g.logicalBytes)} / 已分配 {size(g.allocatedBytes)}
                </span>
              </article>
            ))}
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
        <section className="wl-event-detail">
          <h3>{kind === 'gc' ? '待隔离对象' : '快照清理预览'}</h3>
          {kind === 'gc' ? (
            <p>
              {plan.objects.length} 个对象，共 {size(plan.logicalBytes)}
              。先移入隔离区，可恢复；至少七天后可手动永久删除。
            </p>
          ) : (
            <>
              <p>
                共 {plan.total} 份快照；保留 {plan.protected.length} 份，删除 {plan.delete.length}{' '}
                份。只删除快照记录与对应密钥包。
              </p>
              <details>
                <summary>保留原因与候选清单</summary>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {JSON.stringify({ reasons: plan.reasons, delete: plan.delete }, null, 2)}
                </pre>
              </details>
            </>
          )}
          <button
            className="wl-button"
            disabled={busy || !(kind === 'gc' ? plan.objects.length : plan.delete.length)}
            onClick={async () => {
              const result = await request(`${kind}-apply`, { revision: plan.revision })
              if (result) {
                setMessage(result.note ?? `已清理 ${result.removed.length} 份快照`)
                if (result.id) {
                  setRecord(result.id)
                  setRecords(await api({ action: 'gc-records', id }).catch(() => []))
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
              setRecords(await api({ action: 'gc-records', id }).catch(() => []))
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
