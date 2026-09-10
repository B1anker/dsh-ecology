import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge'
import { Info } from '@phosphor-icons/react/dist/csr/Info'
import { useCallback, useState } from 'react'
import type { MergeCandidate, MergePreview } from '../domain/merge-types.js'
import type { ApiFn } from './api-types.js'
import { useActionRunner, useApiQuery } from './async.js'
import { ErrorText } from './error-text.js'
import { HudSelect } from './hud-controls.js'
import { requestMergePreview } from './merge-preview-request.js'
import { Panel } from './panel.js'
import { type Line, label } from './timeline-model.js'
import { TooltipButton } from './tooltip-button.js'
import { VerificationRecord } from './verification-record.js'
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
  api: ApiFn
  close(): void
  onBusy(value: string): void
  onCommitted(): void
}) {
  const [targetId, setTargetId] = useState('origin')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const targets = lines.filter(
    (line) =>
      line.id !== id &&
      (line.kind === 'origin' || line.kind === 'mirror') &&
      !['applying', 'destroyed', 'unreachable'].includes(line.state),
  )
  const [selected, setSelected] = useState<string[]>([]),
    [config, setConfig] = useState(false)
  const [candidate, setCandidate] = useState<MergeCandidate | null>(null)
  const { pending, error: actionError, setError: setActionError, run } = useActionRunner()
  const requestPreview = useCallback(
    (signal: AbortSignal) => {
      setCandidate(null)
      setConfig(false)
      return requestMergePreview(api, id, targetId, signal)
    },
    [api, id, targetId],
  )
  const {
    data: preview,
    error: previewError,
    reload,
  } = useApiQuery<MergePreview>(api, requestPreview, [id, targetId], {
    onSuccess: (result) => {
      if (result.targetId !== targetId)
        throw new Error('后端未确认所选目标世界线，请更新并重启管理实例后重试。')
      setSelected(
        result.plugins
          .filter((item) => item.changed && !item.blocked && !item.removable)
          .map((item) => item.name),
      )
    },
  })
  const error = previewError || actionError
  const sourceName =
    preview?.sourceName ?? lines.find((line) => line.id === id)?.alias ?? '当前世界线'
  const targetName =
    preview?.targetName ??
    targets.find((line) => line.id === targetId)?.alias ??
    (targetId === 'origin' ? 'main' : targetId)
  const visiblePlugins = (preview?.plugins ?? []).filter(
    (item) =>
      item.name.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === 'all' || (filter === 'changed' ? item.changed : selected.includes(item.name))),
  )
  const perform = (commit: boolean) => {
    if (pending || !preview) return
    const message = commit
      ? `正在备份并合入 ${targetName}…`
      : `正在构建候选并验证，${targetName} 保持运行…`
    onBusy(message)
    void run(
      message,
      (): Promise<MergeCandidate> =>
        api(
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
        ),
      (result) => {
        setCandidate(result)
        if (result.committed) onCommitted()
      },
      '合入失败',
    ).finally(() => onBusy(''))
  }
  return (
    <Panel
      title={candidate ? '合入验证结果' : '合入到另一条世界线'}
      back={
        candidate && !pending
          ? () => {
              setCandidate(null)
              setActionError('')
            }
          : undefined
      }
      close={close}
      closeDisabled={!!pending}
      className="wl-inspector wl-merge-panel"
      aria-label="合入世界线"
      footer={
        <div className="wl-merge-actions">
          {pending && (
            <div className="wl-insight-loading" role="status">
              <CircleNotch className="wl-spin" size={18} />
              {pending}
            </div>
          )}
          {preview && !candidate && (
            <button
              className="wl-button wl-primary"
              disabled={!!pending || (!selected.length && !config)}
              onClick={() => void perform(false)}
            >
              <GitMerge size={16} />
              验证所选内容{selected.length ? `（${selected.length}）` : ''}
            </button>
          )}
          {candidate?.ok && !candidate.committed && (
            <button
              className="wl-button wl-primary"
              disabled={!!pending}
              onClick={() => void perform(true)}
            >
              <CheckCircle size={16} />
              确认合入 {candidate!.targetName}
            </button>
          )}
          {(error || (candidate && !candidate.committed)) && (
            <button
              className="wl-button"
              disabled={!!pending}
              onClick={() => {
                if (error) {
                  setActionError('')
                  reload()
                } else {
                  setCandidate(null)
                  setQuery('')
                  setFilter('all')
                }
              }}
            >
              {error ? '重新预览' : '重新选择'}
            </button>
          )}
          {candidate?.committed && (
            <button className="wl-button" onClick={close}>
              完成
            </button>
          )}
        </div>
      }
    >
      {!candidate && (
        <label className="wl-merge-target">
          合入目标
          <HudSelect
            aria-label="合入目标世界线"
            value={targetId}
            disabled={!!pending}
            onChange={(event) => {
              setCandidate(null)
              setSelected([])
              setActionError('')
              setTargetId(event.target.value)
            }}
          >
            {targets.map((line) => (
              <option key={line.id} value={line.id}>
                {sourceName} → {label(line)}
                {line.kind === 'origin' ? ' · 主干' : ''}
              </option>
            ))}
          </HudSelect>
        </label>
      )}
      {!preview && !error && <p className="wl-muted">正在比较插件与配置…</p>}
      {preview && !candidate && (
        <>
          <div className="wl-merge-picker">
            <div className="wl-merge-list-heading">
              <strong>插件</strong>
              <span aria-live="polite">
                已选 {selected.length} / {preview.plugins.length}
              </span>
            </div>
            <input
              type="search"
              className="wl-merge-search"
              aria-label="搜索插件"
              placeholder="搜索包名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="wl-merge-filters" role="group" aria-label="筛选插件">
              {(
                [
                  ['all', '全部'],
                  ['changed', '有变化'],
                  ['selected', '已选'],
                ] as const
              ).map(([value, text]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {text}
                </button>
              ))}
            </div>
            <div className="wl-merge-plugin-list" role="group" aria-label="选择合入插件">
              {visiblePlugins.map((item) => (
                <label
                  key={item.name}
                  className="wl-merge-plugin"
                  data-selected={selected.includes(item.name)}
                  data-blocked={!!item.blocked}
                >
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
                      {item.removable ? ' · 将移除' : !item.changed ? ' · 无变化' : ''}
                    </small>
                    {item.blocked && <small className="wl-merge-blocked">{item.blocked}</small>}
                  </span>
                </label>
              ))}
              {!visiblePlugins.length && (
                <p className="wl-muted">
                  {query
                    ? '没有匹配的插件'
                    : filter === 'selected'
                      ? '尚未选择插件'
                      : '没有变化的插件'}
                </p>
              )}
            </div>
          </div>
          <div className="wl-merge-config-row">
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
              同时复制运行设置
            </label>
            <TooltipButton
              type="button"
              className="wl-merge-info"
              aria-label="复制运行设置说明"
              tooltipTitle={`对 ${targetName} 的影响`}
              tooltipDescription={
                <>
                  <p>不勾选：对 {targetName} 只变更合入的所选插件</p>
                  <p>勾选：对 {targetName} 的变更包括合入所选插件和运行设置</p>
                  <p>运行设置：</p>
                  <ul className="wl-tooltip-setting-list">
                    <li>插件的启用、停用状态</li>
                    <li>插件的具体选项和参数，例如配置中填写的服务地址、端口等</li>
                  </ul>
                </>
              }
            >
              <Info size={16} />
            </TooltipButton>
          </div>
        </>
      )}
      {candidate && (
        <div className="wl-merge-result-page" key={candidate.id}>
          <strong>
            {candidate.committed
              ? `已合入 ${candidate.targetName}`
              : candidate.ok
                ? '候选验证通过'
                : candidate.reviewable
                  ? '旧版验证记录，请重新验证'
                  : '验证未通过'}
          </strong>
          <p>{candidate.detail}</p>
          <VerificationRecord key={candidate.labId} id={candidate.labId} api={api} expanded />
          {candidate.ok && (
            <>
              <p className="wl-muted">
                {candidate.plugins.length} 个插件
                {candidate.includeConfig
                  ? ` · 使用 ${candidate.sourceName} 的运行设置`
                  : ` · 保留 ${candidate.targetName} 的运行设置`}
              </p>
              <ul>
                {candidate.plugins.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </>
          )}
          {candidate.preSnapshot && <p className="wl-muted">合入前快照：{candidate.preSnapshot}</p>}
        </div>
      )}
      {error && (
        <div role="alert" className="wl-merge-error">
          <strong>{candidate ? '合入未完成' : '无法准备合入'}</strong>
          <ErrorText message={error} role={null} />
        </div>
      )}
    </Panel>
  )
}
