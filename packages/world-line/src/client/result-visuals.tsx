import { Fragment } from 'react'
import {
  browserVerdict,
  type ChangeGroups,
  changeCounts,
  changeKinds,
  retentionCounts,
} from './result-visual-data.js'
import { storageSize } from './storage-overview.js'

function VizHeading({ title, code }: { title: string; code: string }) {
  return (
    <header className="wl-viz-heading">
      <span className="wl-viz-emblem" aria-hidden="true">
        ◇
      </span>
      <div>
        <small aria-hidden="true">WORLD LINE / {code}</small>
        <strong>{title}</strong>
      </div>
    </header>
  )
}

/** Counts are per entry within each group, not a count of unique affected files. */
export function ChangeSummary({ diff }: { diff: ChangeGroups }) {
  const counts = changeCounts(diff)
  const totals = changeKinds.map((_, i) => counts.reduce((sum, row) => sum + row.values[i]!, 0))
  const largest = Math.max(1, ...counts.map((row) => row.values.reduce((a, b) => a + b, 0)))
  return (
    <section className="wl-viz" aria-label="差异概览">
      <VizHeading title="差异概览" code="COMPARE" />
      <div className="wl-viz-stats">
        {changeKinds.map((kind, i) => (
          <div key={kind.id}>
            <span>
              {kind.mark} {kind.label}
            </span>
            <strong>{totals[i]}</strong>
          </div>
        ))}
      </div>
      {counts.map((row) => (
        <div className="wl-change-chart" key={row.key}>
          <span>{row.label}</span>
          <div className="wl-viz-track" aria-hidden="true">
            {changeKinds.map((kind, i) => (
              <i
                key={kind.id}
                style={{ width: `${(row.values[i]! / largest) * 100}%`, background: kind.color }}
              />
            ))}
          </div>
          <strong>{row.values.reduce((a, b) => a + b, 0)}</strong>
          <small>
            {changeKinds.map((kind, i) => `${kind.label} ${row.values[i]}`).join(' · ')}
          </small>
        </div>
      ))}
      <small className="wl-muted">仅统计变化条目；文件与配置项分别计数。下方保留逐项明细。</small>
    </section>
  )
}
export function VersionPair({ before, after }: { before?: string; after?: string }) {
  return (
    <div className="wl-version-pair">
      <div>
        <small>基准</small>
        <span>{before || '未安装'}</span>
      </div>
      <span aria-hidden="true">→</span>
      <div>
        <small>目标</small>
        <span>{after || '未安装'}</span>
      </div>
    </div>
  )
}

type MatrixRow = {
  version: string
  ok?: boolean
  clientGate?: string
  adapterCertified?: boolean
  error?: string
  labId?: string
}
export function CompatibilityMatrix({ rows }: { rows: MatrixRow[] }) {
  const cell = (state: 'pass' | 'fail' | 'unknown', text: string) => (
    <span className="wl-viz-status" data-state={state}>
      <b aria-hidden="true">{state === 'pass' ? '✓' : state === 'fail' ? '×' : '—'}</b> {text}
    </span>
  )
  if (!rows.length) return <p className="wl-muted">暂无已记录的版本结果。</p>
  return (
    <section className="wl-viz" aria-label="宿主版本兼容矩阵">
      <VizHeading title="宿主版本兼容矩阵" code="COMPATIBILITY" />
      <small className="wl-muted">每行一个宿主版本；未记录不代表通过。</small>
      <div
        className="wl-matrix-scroll"
        tabIndex={0}
        role="region"
        aria-label="兼容矩阵表格，可横向滚动"
      >
        <table className="wl-viz-table">
          <thead>
            <tr>
              <th scope="col">宿主版本</th>
              <th scope="col">整体验证</th>
              <th scope="col">浏览器</th>
              <th scope="col">适配器认证</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <Fragment key={`${row.version}-${i}`}>
                <tr>
                  <th scope="row">{row.version}</th>
                  <td>
                    {cell(
                      row.ok === true ? 'pass' : row.ok === false ? 'fail' : 'unknown',
                      row.ok === true ? '通过' : row.ok === false ? '未通过' : '未记录',
                    )}
                  </td>
                  <td>
                    {cell(
                      browserVerdict(row.clientGate).state,
                      browserVerdict(row.clientGate).text,
                    )}
                  </td>
                  <td>
                    {cell(
                      row.adapterCertified === true ? 'pass' : 'unknown',
                      row.adapterCertified === true
                        ? '已认证'
                        : row.adapterCertified === false
                          ? '未认证'
                          : '未记录',
                    )}
                  </td>
                </tr>
                {(row.error || row.labId) && (
                  <tr>
                    <td colSpan={4} className="wl-matrix-note">
                      {row.error}
                      {row.error && row.labId ? ' · ' : ''}
                      {row.labId ? `实验：${row.labId}` : ''}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <small className="wl-muted">矩阵结果不代表可以升级正式宿主，跨版本实验不提供直接合入。</small>
    </section>
  )
}
export function UpgradeResults({
  rows,
}: {
  rows: { name: string; from?: string; to?: string; status: string; reason?: string }[]
}) {
  if (!rows.length) return <p className="wl-muted">本次没有记录到升级候选或查询失败。</p>
  return (
    <div className="wl-viz" aria-label="升级验证结果">
      <VizHeading title="升级验证结果" code="UPGRADE" />
      <div className="wl-viz-stats">
        <div>
          <span>验证通过</span>
          <strong>{rows.filter((row) => row.status === 'verified').length}</strong>
        </div>
        <div>
          <span>未通过 / 待处理</span>
          <strong>{rows.filter((row) => row.status !== 'verified').length}</strong>
        </div>
      </div>
      {rows.map((row, i) => (
        <article className="wl-upgrade-row" key={`${row.name}-${i}`}>
          <strong>{row.name}</strong>
          <span className="wl-viz-status" data-state={row.status === 'verified' ? 'pass' : 'fail'}>
            {row.status === 'verified'
              ? '✓ 已验证'
              : row.status === 'failed'
                ? '× 未通过'
                : `— ${row.status}`}
          </span>
          <VersionPair before={row.from ?? '未记录'} after={row.to ?? '未记录'} />
          {row.reason && <small>{row.reason}</small>}
        </article>
      ))}
    </div>
  )
}

export function CleanupSummary({
  plan,
  kind,
}: {
  kind: string
  plan: {
    total?: number
    delete?: string[]
    protected?: string[]
    corrupt?: number
    reasons?: Record<string, string>
    objects?: { id: string; bytes: number }[]
    logicalBytes?: number
  }
}) {
  if (kind === 'gc')
    return (
      <div className="wl-viz" aria-label="对象隔离预览">
        <VizHeading title="对象隔离" code="QUARANTINE" />
        <div className="wl-viz-stats">
          <div>
            <span>待隔离对象</span>
            <strong>{plan.objects?.length ?? 0}</strong>
          </div>
          <div>
            <span>对象逻辑大小</span>
            <strong>{storageSize(plan.logicalBytes ?? 0)}</strong>
          </div>
        </div>
        <ol className="wl-cleanup-steps">
          <li>
            <strong>隔离</strong>
            <small>确认后移入回收区</small>
          </li>
          <li>
            <strong>可恢复</strong>
            <small>保留至少七天</small>
          </li>
          <li>
            <strong>永久删除</strong>
            <small>到期后仍需手动确认</small>
          </li>
        </ol>
        <p className="wl-muted">这是待隔离对象的逻辑大小，不是立即释放的磁盘空间。</p>
        <details>
          <summary>查看 {plan.objects?.length ?? 0} 个候选对象</summary>
          <ul className="wl-cleanup-list">
            {plan.objects?.map((object) => (
              <li key={object.id}>
                <code>{object.id}</code>
                <span>{storageSize(object.bytes)}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    )
  const { total, removed, kept, keptPercent, removedPercent } = retentionCounts(
    plan.total ?? 0,
    plan.delete ?? [],
  )
  const reason = (text: string) =>
    text
      .replace('explicitly protected (lastKnownGood)', '稳定点保护')
      .replace('explicitly protected', '显式保护')
      .replace(/^parent of /, '保留快照的父级：')
      .replace(/^within the (\d+) most recent$/, '最近 $1 份快照')
      .replace(/^newest of day /, '当日最新：')
      .replace(/^newest of week /, '当周最新：')
  return (
    <div className="wl-viz" aria-label="快照保留分布">
      <VizHeading title="快照保留分布" code="RETENTION" />
      <div className="wl-viz-stats">
        <div>
          <span>保留</span>
          <strong>{kept}</strong>
        </div>
        <div>
          <span>待删除</span>
          <strong>{removed}</strong>
        </div>
        <div>
          <span>总快照</span>
          <strong>{total}</strong>
        </div>
      </div>
      {total > 0 && (
        <div className="wl-viz-track wl-cleanup-track" aria-hidden="true">
          <i style={{ width: `${keptPercent}%`, background: 'var(--wl-menu-gold,#edbb16)' }} />
          <i style={{ width: `${removedPercent}%`, background: '#a6a59b' }} />
        </div>
      )}
      <small className="wl-muted">
        保留 {keptPercent.toFixed(1)}% · 待删除 {removedPercent.toFixed(1)}%
      </small>
      <p>
        {removed
          ? '仅删除候选快照记录与对应密钥包，不直接回收共享内容对象。'
          : '当前策略下没有可删除的快照。'}
      </p>
      {!!plan.corrupt && (
        <p className="wl-error">另有 {plan.corrupt} 份损坏记录未计入，请先检查。</p>
      )}
      <details>
        <summary>查看待删除清单（{removed}）</summary>
        <ul className="wl-cleanup-list">
          {plan.delete?.map((id) => (
            <li key={id}>
              <code>{id}</code>
              <span>待删除</span>
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>查看保护原因（{plan.protected?.length ?? 0}）</summary>
        <ul className="wl-cleanup-list">
          {plan.protected?.map((id) => (
            <li key={id}>
              <code>{id}</code>
              <span>{reason(plan.reasons?.[id] ?? '策略保留')}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
