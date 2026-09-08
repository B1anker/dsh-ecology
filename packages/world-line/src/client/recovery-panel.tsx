import { useEffect, useState } from 'react'
export function RecoveryPanel({
  id,
  api,
  onVerify,
}: {
  id: string
  api(body: unknown): Promise<any>
  onVerify(id: string): void
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<{
    recordId: string
    transaction: boolean
    labId?: string
  } | null>(null)
  const [stopped, setStopped] = useState(false),
    [breakStale, setBreakStale] = useState(false)
  const refresh = () =>
    api({ action: 'recovery-list', id })
      .then(setData)
      .catch((e) => setError(e.message))
  useEffect(() => {
    void refresh()
  }, [id])
  return (
    <div className="wl-flow-actions">
      <p>先恢复受管文件和事务记录，再重新验证实例。外部修改冲突不会被覆盖。</p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      <button className="wl-button" disabled={busy} onClick={() => void refresh()}>
        刷新恢复记录
      </button>
      {data && !data.swaps.length && !data.transactions.some((r: any) => r.pending) && (
        <p>没有待恢复记录。</p>
      )}
      {data?.swaps.map((recordId: string) => (
        <button
          className="wl-button"
          key={recordId}
          onClick={() => setSelected({ recordId, transaction: false })}
        >
          恢复文件交换 {recordId}
        </button>
      ))}
      {data?.transactions
        .filter((r: any) => r.pending)
        .map((r: any) => (
          <article className="wl-event-detail" key={r.id}>
            <p>
              {r.id} · {r.phase}
            </p>
            <button
              className="wl-button"
              onClick={() => setSelected({ recordId: r.id, transaction: true, labId: r.labId })}
            >
              检查并恢复
            </button>
          </article>
        ))}
      {selected && (
        <section className="wl-event-detail">
          <p>
            恢复 {selected.recordId}
            ：未提交事务恢复原文件，已决定提交的事务补齐记录。此操作本身不表示实例已健康。
          </p>
          <label>
            <input
              type="checkbox"
              checked={stopped}
              onChange={(e) => setStopped(e.target.checked)}
            />
            相关安装器和验证进程已停止
          </label>
          <label>
            <input
              type="checkbox"
              checked={breakStale}
              onChange={(e) => setBreakStale(e.target.checked)}
            />
            允许移除已确认失效的锁（活动锁仍会阻止操作）
          </label>
          <button
            className="wl-button primary"
            disabled={busy || !stopped}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await api({
                  action: 'recovery-apply',
                  id,
                  ...selected,
                  runtimeStopped: stopped,
                  breakStale,
                })
                setData(null)
                await refresh()
                setSelected(null)
              } catch (e) {
                setError(e instanceof Error ? e.message : '恢复失败')
              } finally {
                setBusy(false)
              }
            }}
          >
            确认恢复
          </button>
          <button className="wl-button" onClick={() => setSelected(null)}>
            取消
          </button>
        </section>
      )}
      {data?.transactions
        .filter((r: any) => !r.pending)
        .map((r: any) => (
          <article className="wl-event-detail" key={r.id}>
            <p>
              {r.id} · {r.phase}
            </p>
            <button className="wl-button" onClick={() => onVerify(r.labId)}>
              重新验证实验
            </button>
          </article>
        ))}
    </div>
  )
}
