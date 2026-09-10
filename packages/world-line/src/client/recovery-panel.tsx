import { useState } from 'react'
import type { ApiFn } from './api-types.js'
import { useActionRunner, useApiQuery } from './async.js'
import { ErrorText } from './error-text.js'

type RecoverySelection = { recordId: string; transaction: boolean; labId?: string }
export function RecoveryPanel({
  id,
  api,
  onVerify,
}: {
  id: string
  api: ApiFn
  onVerify(id: string): void
}) {
  // id 切换时由调用方以 key 重挂载，从而重置列表与下方选择状态。
  const {
    data,
    error: loadError,
    loading,
    reload,
  } = useApiQuery<any>(api, { action: 'recovery-list', id }, [id], {
    fallback: '恢复记录读取失败',
    keepData: true,
  })
  const { pending, error: actionError, setError: setActionError, run } = useActionRunner()
  const busy = !!pending
  const error = loadError || actionError
  const [selected, setSelected] = useState<RecoverySelection | null>(null)
  const [stopped, setStopped] = useState(false),
    [breakStale, setBreakStale] = useState(false)
  const selectRecord = (record: RecoverySelection | null) => {
    setSelected(record)
    setStopped(false)
    setBreakStale(false)
    setActionError('')
  }
  const completed = data?.transactions.filter((record: any) => !record.pending) ?? []
  return (
    <div className="wl-flow-actions">
      <p>安装或合入意外中断时，在这里修复未完成的操作，再重新验证环境。外部修改冲突不会被覆盖。</p>
      {error && <ErrorText message={error} />}
      <button className="wl-button" disabled={busy || loading} onClick={() => reload()}>
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
            onClick={() => {
              void run(
                '处理中…',
                () =>
                  api({
                    action: 'recovery-apply',
                    id,
                    ...selected,
                    runtimeStopped: stopped,
                    breakStale,
                  }),
                () => {
                  reload()
                  setSelected(null)
                  setStopped(false)
                  setBreakStale(false)
                },
                '恢复失败',
              )
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
