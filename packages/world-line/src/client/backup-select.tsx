import { useCallback } from 'react'
import type { SnapshotDetail, WorldEvent } from '../domain/insight-types.js'
import type { ApiFn } from './api-types.js'
import { useApiQuery } from './async.js'
import { backupDescription } from './backup-description.js'
import { HudSelect } from './hud-controls.js'

export function BackupSelect({
  label,
  value,
  onChange,
  points,
  events,
  id,
  api,
  disabled,
}: {
  label: string
  value: string
  onChange(value: string): void
  points: WorldEvent[]
  events: WorldEvent[]
  id: string
  api: ApiFn
  disabled: boolean
}) {
  // 原实现忽略底层错误、统一展示固定文案：抛出非 Error 使 errorMessage 落到 fallback。
  const request = useCallback(
    () =>
      api({ action: 'snapshot-detail', id, snapshotId: value }).catch(() => {
        throw '备份内容读取失败'
      }),
    [api, id, value],
  )
  const {
    data: detail,
    error,
    reload,
  } = useApiQuery<SnapshotDetail>(api, value ? request : null, [id, value], {
    fallback: '备份内容读取失败',
  })
  const point = points.find((point) => point.snapshotId === value)
  const description = point && backupDescription(point, events)
  return (
    <div>
      <label>
        {label}
        <HudSelect
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">选择备份</option>
          {points.map((point) => (
            <option key={point.snapshotId} value={point.snapshotId}>
              {backupDescription(point, events).label} · {new Date(point.at).toLocaleString()}
            </option>
          ))}
        </HudSelect>
      </label>
      {description && (
        <div className="wl-muted">
          <p>{description.explanation}</p>
          {description.operations.map((operation) => (
            <div key={operation.id}>
              <p>关联操作：{operation.title}</p>
              {operation.packages?.map((plugin) => (
                <p key={plugin.name}>
                  {plugin.name} · {plugin.version}
                </p>
              ))}
            </div>
          ))}
          {error ? (
            <p role="alert">
              {error}{' '}
              <button className="wl-button" onClick={reload}>
                重试
              </button>
            </p>
          ) : !detail ? (
            <p role="status">正在读取备份内容…</p>
          ) : (
            <details key={value} open>
              <summary>备份内的插件（{detail.dependencies.length}）</summary>
              {detail.dependencies.map((plugin) => (
                <p key={plugin.name}>
                  {plugin.name} · {plugin.version}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  )
}
