import { useCallback, useEffect, useRef, useState } from 'react'

type RecoverySelection = { recordId: string; transaction: boolean; labId?: string }
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
  const [selected, setSelected] = useState<RecoverySelection | null>(null)
  const [stopped, setStopped] = useState(false),
    [breakStale, setBreakStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const loadVersion = useRef(0)
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    setError('')
    try {
      const result = await api({ action: 'recovery-list', id })
      if (loadVersion.current === version) setData(result)
    } catch (e) {
      if (loadVersion.current === version)
        setError(e instanceof Error ? e.message : '恢复记录读取失败')
    } finally {
      if (loadVersion.current === version) setLoading(false)
    }
  }, [api, id])
  const selectRecord = (record: RecoverySelection | null) => {
    setSelected(record)
    setStopped(false)
    setBreakStale(false)
    setError('')
  }
  useEffect(() => {
    setData(null)
    setSelected(null)
    setStopped(false)
    setBreakStale(false)
    void refresh()
    return () => {
      loadVersion.current += 1
    }
  }, [refresh])
  const completed = data?.transactions.filter((record: any) => !record.pending) ?? []
  return (
    <div className="wl-flow-actions">
      <p>安装或合入意外中断时，在这里修复未完成的操作，再重新验证环境。外部修改冲突不会被覆盖。</p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      <button className="wl-button" disabled={busy || loading} onClick={() => void refresh()}>
        {loading ? '正在读取…' : '刷新恢复记录'}
      </button>
      {data && !data.swaps.length && !data.transactions.some((r: any) => r.pending) && (
        <p>没有需要修复的中断操作。</p>
      )}
      {data?.swaps.map((recordId: string) => (
        <button
          className="wl-button"
          key={recordId}
          disabled={busy}
          onClick={() => selectRecord({ recordId, transaction: false })}
        >
          修复中断的文件更新 {recordId}
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
              disabled={busy}
              onClick={() => selectRecord({ recordId: r.id, transaction: true, labId: r.labId })}
            >
              检查并修复
            </button>
          </article>
        ))}
      {selected && (
        <section className="wl-event-detail">
          <p>
            修复 {selected.recordId}
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
            className="wl-button wl-primary"
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
                setStopped(false)
                setBreakStale(false)
              } catch (e) {
                setError(e instanceof Error ? e.message : '恢复失败')
              } finally {
                setBusy(false)
              }
            }}
          >
            确认修复
          </button>
          <button className="wl-button" disabled={busy} onClick={() => selectRecord(null)}>
            取消
          </button>
        </section>
      )}
      {completed.length > 0 && (
        <details className="wl-advanced">
          <summary>已处理记录（{completed.length}）</summary>
          <p className="wl-muted">这些操作已处理。只有仍需确认环境状态时，才需要重新验证。</p>
          {completed.map((r: any) => (
            <article className="wl-event-detail" key={r.id}>
              <p>
                {r.id} · {r.phase}
              </p>
              {r.labId && (
                <button className="wl-button" disabled={busy} onClick={() => onVerify(r.labId)}>
                  重新验证环境
                </button>
              )}
            </article>
          ))}
        </details>
      )}
    </div>
  )
}
