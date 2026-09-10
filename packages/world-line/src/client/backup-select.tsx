import { useEffect, useState } from 'react'
import type { SnapshotDetail, WorldEvent } from '../domain/insight-types.js'
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
  api(body: unknown): Promise<any>
  disabled: boolean
}) {
  const [detail, setDetail] = useState<SnapshotDetail | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setDetail(null)
    setError('')
    if (value)
      void api({ action: 'snapshot-detail', id, snapshotId: value })
        .then((result) => {
          if (current) setDetail(result)
        })
        .catch(() => {
          if (current) setError('备份内容读取失败')
        })
    return () => {
      current = false
    }
  }, [api, id, value, revision])
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
              <button className="wl-button" onClick={() => setRevision((n) => n + 1)}>
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
