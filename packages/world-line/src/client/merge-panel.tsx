import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge'
import { X } from '@phosphor-icons/react/dist/csr/X'
import { useEffect, useState } from 'react'
import type { MergeCandidate, MergePreview } from '../domain/merge-types.js'
import { HudSelect } from './hud-controls.js'
import { type Line, label } from './timeline-model.js'
export function MergePanel({
  id,
  lines,
  api,
  close,
  onBusy,
  onCommitted,
}: {
  id: string
  lines: Line[]
  api(body: unknown, signal?: AbortSignal): Promise<any>
  close(): void
  onBusy(value: string): void
  onCommitted(): void
}) {
  const [targetId, setTargetId] = useState('origin')
  const targets = lines.filter(
    (line) =>
      line.id !== id &&
      (line.kind === 'origin' || line.kind === 'mirror') &&
      !['applying', 'destroyed', 'unreachable'].includes(line.state),
  )
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const targetName =
    preview?.targetName ??
    targets.find((line) => line.id === targetId)?.alias ??
    (targetId === 'origin' ? 'main' : targetId)
  const [selected, setSelected] = useState<string[]>([]),
    [config, setConfig] = useState(false)
  const [candidate, setCandidate] = useState<MergeCandidate | null>(null)
  const [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setPreview(null)
    setCandidate(null)
    setError('')
    setConfig(false)
    void api({ action: 'merge-preview', id, targetId }, abort.signal)
      .then((result: MergePreview) => {
        if (abort.signal.aborted) return
        if (result.targetId !== targetId)
          throw new Error('后端未确认所选目标世界线，请更新并重启管理实例后重试。')
        setPreview(result)
        setSelected(
          result.plugins
            .filter((item) => item.changed && !item.blocked && !item.removable)
            .map((item) => item.name),
        )
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message)
      })
    return () => abort.abort()
  }, [id, targetId, api, revision])
  const perform = async (commit: boolean) => {
    if (pending || !preview) return
    const message = commit
      ? `正在备份并合入 ${targetName}…`
      : `正在构建候选并验证，${targetName} 保持运行…`
    setPending(message)
    onBusy(message)
    setError('')
    try {
      const result: MergeCandidate = await api(
        commit
          ? { action: 'merge-commit', id: candidate!.id }
          : {
              action: 'merge-prepare',
              id,
              targetId: preview.targetId,
              revision: preview.revision,
              plugins: selected,
              includeConfig: config,
            },
      )
      setCandidate(result)
      if (result.committed) onCommitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : '合入失败')
    } finally {
      setPending('')
      onBusy('')
    }
  }
  return (
    <aside className="wl-inspector wl-merge-panel" aria-label="合入世界线">
      <header className="wl-header">
        <div>
          <span className="wl-eyebrow">CONVERGENCE</span>
          <h2>合入到另一条世界线</h2>
        </div>
        <button
          className="wl-button wl-icon"
          aria-label="关闭合入面板"
          disabled={!!pending}
          onClick={close}
        >
          <X size={16} />
        </button>
      </header>
      <label>
        合入目标
        <HudSelect
          aria-label="合入目标世界线"
          value={targetId}
          disabled={!!pending}
          onChange={(event) => {
            setPreview(null)
            setCandidate(null)
            setSelected([])
            setTargetId(event.target.value)
          }}
        >
          {targets.map((line) => (
            <option key={line.id} value={line.id}>
              {label(line)}
              {line.kind === 'origin' ? ' · 主干' : ''}
            </option>
          ))}
        </HudSelect>
      </label>
      <p className="wl-muted">
        {preview?.sourceName ?? '世界线'} → {targetName}
      </p>
      {!preview && !error && <p className="wl-muted">正在比较插件与配置…</p>}
      {preview && !candidate?.ok && (
        <>
          <p className="wl-muted">
            只更新勾选的插件和对应 bundle，未勾选的目标世界线能力保留。移除插件需要单独勾选。
          </p>
          <div className="wl-merge-options">
            {preview.plugins.map((item) => (
              <label key={item.name} title={item.blocked}>
                <input
                  type="checkbox"
                  aria-label={`合入 ${item.name}`}
                  checked={selected.includes(item.name)}
                  disabled={!!pending || !!item.blocked}
                  onChange={(event) => {
                    setCandidate(null)
                    setSelected((values) =>
                      event.target.checked
                        ? [...values, item.name]
                        : values.filter((name) => name !== item.name),
                    )
                  }}
                />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.before} → {item.after}
                    {!item.changed ? ' · 无内容差异' : ''}
                  </small>
                  {item.blocked && <small>{item.blocked}</small>}
                </span>
              </label>
            ))}
          </div>
          <label className="wl-merge-config">
            <input
              type="checkbox"
              checked={config}
              disabled={!!pending}
              onChange={(event) => {
                setConfig(event.target.checked)
                setCandidate(null)
              }}
            />
            同步 profile 配置
          </label>
          <p className="wl-muted">
            {config
              ? '将完整替换目标世界线的 profile 配置补丁，包括其中的配置值。请确认来源配置适用于目标世界线。'
              : '默认保留目标配置。'}{' '}
            会话、模型设置、登录状态和 home 配置不会合入。
          </p>
          <button
            className="wl-button wl-primary"
            disabled={!!pending || (!selected.length && !config)}
            onClick={() => void perform(false)}
          >
            <GitMerge size={16} />
            生成并验证候选
          </button>
        </>
      )}
      {candidate && (
        <div className="wl-event-detail">
          <strong>
            {candidate.committed
              ? `已合入 ${candidate.targetName}`
              : candidate.ok
                ? '候选验证通过'
                : '验证未通过'}
          </strong>
          <p>{candidate.detail}</p>
          <p className="wl-muted">验证实验：{candidate.labId}</p>
          {candidate.ok && (
            <>
              <p className="wl-muted">
                {candidate.plugins.length} 个插件
                {candidate.includeConfig ? ' · 替换 profile 配置' : ' · 保留目标配置'}
              </p>
              <ul>
                {candidate.plugins.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </>
          )}
          {candidate.preSnapshot && <p className="wl-muted">合入前快照：{candidate.preSnapshot}</p>}
          {candidate.ok && !candidate.committed && (
            <button
              className="wl-button wl-primary"
              disabled={!!pending}
              onClick={() => void perform(true)}
            >
              <CheckCircle size={16} />
              确认合入 {candidate.targetName}
            </button>
          )}
          {!pending && !candidate.committed && (
            <button className="wl-button" onClick={() => setRevision((value) => value + 1)}>
              重新选择与验证
            </button>
          )}
        </div>
      )}
      {pending && (
        <div className="wl-insight-loading" role="status">
          <CircleNotch className="wl-spin" size={18} />
          {pending}
        </div>
      )}
      {error && (
        <div role="alert" className="wl-error">
          {error}
          <button
            className="wl-button"
            disabled={!!pending}
            onClick={() => setRevision((value) => value + 1)}
          >
            重新预览
          </button>
        </div>
      )}
    </aside>
  )
}
