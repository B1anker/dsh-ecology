import { useEffect, useState } from 'react'
import type { ReportResult } from '../commands/report.js'
import type { WorldEvent } from '../domain/insight-types.js'
import type { DependencyRecord } from '../domain/snapshot.js'
import { HudSelect } from './hud-controls.js'
import { useJobFeed } from './job-feed.js'
import { type Job, jobKindLabel } from './job-view.js'
import { Panel } from './panel.js'
import type { ToolPanel } from './panels.js'
import { RecoveryPanel } from './recovery-panel.js'
import { ReportView } from './report-view.js'
import { ResearchPanel } from './research-panel.js'
import { StoragePanel } from './storage-panel.js'
import { type Line, label } from './timeline-model.js'

type Api = (body: unknown, signal?: AbortSignal) => Promise<any>
export function WorkspaceTools({
  panel,
  lines,
  api,
  close,
  navigate,
  onJob,
  onCompareLines,
  onSnapshot,
}: {
  panel: ToolPanel
  lines: Line[]
  api: Api
  close(): void
  navigate(panel: ToolPanel): void
  onJob(id: string): void
  onCompareLines(id: string): void
  onSnapshot(id: string): void
}) {
  const jobs = useJobFeed()
  const [olderJobs, setOlderJobs] = useState<Job[]>([])
  const allJobs = [
    ...jobs,
    ...olderJobs.filter((job) => !jobs.some((current) => current.id === job.id)),
  ]
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [candidate, setCandidate] = useState<{
    action: string
    name: string
    spec: string
  } | null>(null)
  const [text, setText] = useState(''),
    [query, setQuery] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('current')
  const [diff, setDiff] = useState<any>(null)
  const source = lines.find((l) => l.id === panel.id)
  const workflowSource =
    source?.kind === 'verification'
      ? (source.parentId ?? 'origin')
      : panel.id.startsWith('snap-')
        ? (panel.lineId ?? 'origin')
        : panel.id
  const title = {
    composition: '当前组成',
    compare: '历史比较',
    config: '验证配置变更',
    report: '诊断报告',
    tasks: '任务台',
    storage: '存储',
    recovery: '中断恢复',
    research: '环境排障与交付',
  }[panel.section]
  useEffect(() => {
    setData(null)
    setError('')
    setCandidate(null)
    setDiff(null)
    const c = new AbortController()
    const action =
      panel.section === 'composition'
        ? 'composition'
        : panel.section === 'compare'
          ? source?.kind === 'verification'
            ? 'lab-diff'
            : 'snapshot-list'
          : panel.section === 'report'
            ? 'report'
            : null
    if (action)
      void api(
        {
          action,
          id: panel.id,
          ...(action === 'report' && panel.lineId ? { lineId: panel.lineId } : {}),
        },
        c.signal,
      )
        .then((x) => {
          if (!c.signal.aborted) {
            if (action === 'lab-diff') setDiff(x)
            else {
              setData(x)
              if (action === 'snapshot-list') {
                const latest = (x as WorldEvent[])
                  .filter((event) => event.snapshotId)
                  .toSorted((a, b) => b.at.localeCompare(a.at))[0]
                setFrom(latest?.snapshotId ?? '')
                setTo('current')
              }
            }
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message)
        })
    return () => c.abort()
  }, [panel.id, panel.section, api])
  const run = async (body: unknown) => {
    setBusy(true)
    setError('')
    try {
      const r = await api(body)
      onJob(r.jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  const ref = (id: string) => ({
    lineId: panel.id,
    kind: id === 'current' ? 'current' : 'snapshot',
    ...(id === 'current' ? {} : { snapshotId: id }),
  })
  return (
    <Panel title={title} close={close} className="wl-inspector" aria-label={title}>
      <p>环境：{source ? label(source) : panel.id}</p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="wl-flow-actions-row"
        hidden={panel.section === 'research' || panel.section === 'recovery'}
      >
        <button
          className="wl-button"
          onClick={() =>
            navigate({
              section: 'recovery',
              id: workflowSource,
            })
          }
        >
          中断恢复
        </button>
        <button
          className="wl-button"
          onClick={() => navigate({ section: 'research', id: workflowSource })}
        >
          排障与交付
        </button>
      </div>
      {panel.section === 'research' && <ResearchPanel id={panel.id} api={api} onJob={onJob} />}
      {panel.section === 'recovery' && (
        <RecoveryPanel
          id={panel.id}
          api={api}
          onVerify={(id) => void run({ action: 'lab-verify', id })}
        />
      )}
      {panel.section === 'storage' && (
        <StoragePanel
          id={panel.id}
          api={api}
          names={Object.fromEntries(
            lines.map((line) => [
              `${line.kind === 'rescue' ? 'rescues' : 'labs'}/${line.id}`,
              label(line),
            ]),
          )}
        />
      )}
      {panel.section === 'tasks' && (
        <>
          <p className="wl-muted">关闭面板不影响任务。中断任务需要检查结果后重新验证。</p>
          <button
            className="wl-button"
            onClick={async () => {
              if ('Notification' in window) {
                const permission = await Notification.requestPermission()
                setError(permission === 'denied' ? '浏览器未允许通知，仍会显示站内提醒。' : '')
                localStorage.setItem(
                  'wl-task-notifications',
                  permission === 'granted' ? 'on' : 'off',
                )
              }
            }}
          >
            启用任务完成通知
          </button>
          {allJobs.map((job) => (
            <article className="wl-event-detail" key={job.id}>
              <strong>{jobKindLabel(job.kind)}</strong>
              <span>
                {
                  {
                    queued: '排队中',
                    awaiting_auth: '等待登录',
                    review: '异常待确认',
                    incomplete: '验证未完成',
                    running: '运行中',
                    ok: '已完成',
                    fail: '验证失败',
                    error: '异常',
                    interrupted: '已中断',
                  }[job.status]
                }
              </span>
              <time>{new Date(job.startedAt).toLocaleString()}</time>
              {job.error && <p className="wl-error">{job.error}</p>}
              <button className="wl-button" onClick={() => onJob(job.id)}>
                查看进度与结果
              </button>
              {job.labId && (
                <button
                  className="wl-button"
                  onClick={() => navigate({ section: 'report', id: job.labId! })}
                >
                  诊断报告
                </button>
              )}
              {job.labId && (
                <button
                  className="wl-button"
                  onClick={() => navigate({ section: 'compare', id: job.labId! })}
                >
                  查看实验差异
                </button>
              )}
            </article>
          ))}
          {allJobs.length >= 200 && (
            <button
              className="wl-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const more = await api({
                    action: 'jobs',
                    before: allJobs.at(-1)?.id,
                  })
                  setOlderJobs((previous) => [...previous, ...more])
                  if (!more.length) setError('已显示全部保留任务')
                } catch (e) {
                  setError(String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              加载更早的任务
            </button>
          )}
        </>
      )}
      {panel.section === 'composition' && (
        <>
          {data?.drift && (
            <div className="wl-event-detail" role="status">
              {(['latest', 'lastKnownGood'] as const).map((key) => {
                const comparison = data.drift[key]
                const label = key === 'latest' ? '最近记录' : '已验证稳定点'
                return (
                  <p key={key}>
                    {label}：
                    {comparison.status === 'changed'
                      ? `已变化（${comparison.changedFiles.join('、')}）`
                      : comparison.status === 'same'
                        ? '内容一致'
                        : comparison.status === 'missing'
                          ? '尚无基线'
                          : '暂时无法判断'}
                  </p>
                )
              })}
              <p className="wl-muted">{data.drift.note}</p>
            </div>
          )}
          <div className="wl-flow-actions-row">
            <button
              className="wl-button"
              onClick={() => navigate({ section: 'compare', id: panel.id })}
            >
              查看历史差异
            </button>
            <button
              className="wl-button"
              onClick={() => navigate({ section: 'config', id: panel.id })}
            >
              验证配置变更
            </button>
          </div>
          <p className="wl-muted">
            这里是依赖声明与锁文件信息，不代表插件正在运行。所有变更先进入独立实验。
          </p>
          <input
            aria-label="搜索插件"
            placeholder="搜索插件"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!data && !error && <p>正在读取组成…</p>}
          {data?.warnings?.map((x: string, i: number) => (
            <p className="wl-error" key={i}>
              {x}
            </p>
          ))}
          {candidate && (
            <div className="wl-event-detail">
              <strong>
                {candidate.action === 'lab-remove' ? '确认卸载验证' : '确认版本验证'}：
                {candidate.name}
              </strong>
              <p>
                来源与合入目标：{source ? label(source) : panel.id}
                。此操作只创建验证实验。
              </p>
              {candidate.action !== 'lab-remove' && (
                <label>
                  目标规格（例如 包名@1.2.3）
                  <input
                    value={candidate.spec}
                    onChange={(e) => setCandidate({ ...candidate, spec: e.target.value })}
                  />
                </label>
              )}
              <button
                className="wl-button wl-primary"
                disabled={busy || !candidate.spec.trim() || candidate.spec.endsWith('@')}
                onClick={() =>
                  void run({
                    action: candidate.action,
                    spec: candidate.spec,
                    sourceId: panel.id,
                    keep: true,
                    interactive: true,
                  })
                }
              >
                开始验证
              </button>
              <button className="wl-button" onClick={() => setCandidate(null)}>
                取消
              </button>
            </div>
          )}
          {data?.dependencies
            ?.filter((d: DependencyRecord) => d.name.toLowerCase().includes(query.toLowerCase()))
            .map((d: DependencyRecord & { bundle: boolean; core?: boolean }) => (
              <article className="wl-event-detail" key={d.name}>
                <strong>{d.name}</strong>
                <span>
                  解析版本：{d.resolved?.version ?? '未知'} · {d.bundle ? 'Bundle · ' : ''}
                  {{
                    registry: '注册表',
                    file: '本地文件',
                    link: '本地链接',
                    git: 'Git 仓库',
                    workspace: '工作区',
                    tarball: '压缩包',
                    unknown: '未知',
                  }[d.kind] ?? d.kind}
                  {d.core ? ' · 核心运行层' : ''}
                </span>
                <p>声明：{d.spec}</p>
                {d.target && (
                  <p className={d.targetExists ? 'wl-muted' : 'wl-error'}>
                    {d.target} · {d.targetExists ? '路径存在' : '路径不可用'}
                  </p>
                )}
                <div className="wl-experiment-actions">
                  <button
                    className="wl-button"
                    onClick={() =>
                      setCandidate({
                        action: d.kind === 'file' || d.kind === 'link' ? 'lab-add' : 'lab-update',
                        name: d.name,
                        spec:
                          d.kind === 'file' || d.kind === 'link'
                            ? (d.target ?? d.spec)
                            : `${d.name}@`,
                      })
                    }
                  >
                    {d.kind === 'file' || d.kind === 'link' ? '重新验证本地版本' : '升级'}
                  </button>
                  <button
                    className="wl-button"
                    disabled={d.core}
                    title={d.core ? '核心运行层不可卸载' : undefined}
                    onClick={() =>
                      setCandidate({
                        action: 'lab-remove',
                        name: d.name,
                        spec: d.name,
                      })
                    }
                  >
                    卸载
                  </button>
                  <button
                    className="wl-button"
                    onClick={() => navigate({ section: 'compare', id: panel.id })}
                  >
                    查看差异
                  </button>
                </div>
              </article>
            ))}
        </>
      )}
      {panel.section === 'config' && (
        <>
          <p>提交 YAML 配置补丁，在独立实验中验证。不会在预览中执行配置代码。</p>
          <textarea
            aria-label="YAML 配置补丁"
            rows={15}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={65536}
          />
          <button
            className="wl-button wl-primary"
            disabled={busy || !text.trim()}
            onClick={() =>
              void run({
                action: 'lab-config-apply',
                sourceId: panel.id,
                text,
                keep: true,
                interactive: true,
              })
            }
          >
            创建实验并验证配置
          </button>
        </>
      )}
      {panel.section === 'report' &&
        (data ? <ReportView report={data as ReportResult} /> : !error && <p>正在生成脱敏报告…</p>)}
      {panel.section === 'compare' && (
        <>
          <button className="wl-button" onClick={() => onCompareLines(workflowSource)}>
            比较两条世界线的当前状态
          </button>
          {source?.kind === 'verification' ? (
            <p className="wl-muted">以下是本次验证相对安装前的变化。</p>
          ) : data === null ? (
            !error && <p role="status">正在读取历史快照…</p>
          ) : data.length === 0 ? (
            <div className="wl-event-detail">
              <strong>这条世界线还没有历史快照</strong>
              <p className="wl-muted">
                历史比较需要至少一份快照。先保存快照，后续修改插件或配置后，就能与保存时的状态比较。若要比较现有环境，请使用上方的双线比较。
              </p>
              <button className="wl-button" onClick={() => onSnapshot(panel.id)}>
                保存当前快照
              </button>
            </div>
          ) : (
            <>
              <p className="wl-muted">
                比较这条世界线的历史快照与当前状态，也可以选择两份快照。默认以最新快照为基准。
              </p>
              {[
                { value: from, set: setFrom, name: '比较基准' },
                { value: to, set: setTo, name: '比较目标' },
              ].map((side) => (
                <label key={side.name}>
                  {side.name}
                  <HudSelect
                    aria-label={side.name}
                    value={side.value}
                    onChange={(e) => {
                      side.set(e.target.value)
                      setDiff(null)
                    }}
                  >
                    <option value="">请选择</option>
                    <option value="current">{source ? label(source) : panel.id} · 当前状态</option>
                    {(data as WorldEvent[] | null)?.map((e) => (
                      <option key={e.id} value={e.snapshotId}>
                        {e.title} · {new Date(e.at).toLocaleString()}
                      </option>
                    ))}
                  </HudSelect>
                </label>
              ))}
              <button
                className="wl-button"
                disabled={busy || !from || !to || from === to}
                onClick={async () => {
                  setBusy(true)
                  setError('')
                  try {
                    setDiff(
                      await api({
                        action: 'snapshot-compare',
                        from: ref(from),
                        to: ref(to),
                      }),
                    )
                  } catch (e) {
                    setError(String(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                比较
              </button>
              {from === to && <p className="wl-muted">请选择不同的状态进行比较。</p>}
            </>
          )}
          {diff && (
            <>
              <p>读取于 {new Date(diff.at).toLocaleString()}</p>
              {['dependencies', 'files', 'patches'].map((k) => (
                <details open className="wl-event-detail" key={k}>
                  <summary>
                    {
                      {
                        dependencies: '插件变化',
                        files: '文件变化',
                        patches: '配置变化',
                      }[k]
                    }
                  </summary>
                  {(diff.diff[k] ?? []).filter((entry: any) => entry.status !== 'unchanged')
                    .length === 0 ? (
                    <p className="wl-muted">没有变化</p>
                  ) : (
                    (diff.diff[k] ?? [])
                      .filter((entry: any) => entry.status !== 'unchanged')
                      .map((entry: any, i: number) => (
                        <div key={i} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
                          <strong>{entry.name ?? entry.id ?? entry.key ?? entry.file}</strong>
                          <p>
                            {{
                              added: '新增',
                              removed: '移除',
                              changed: '变更',
                            }[entry.status as string] ?? entry.status}
                            {k === 'dependencies' &&
                              ` · ${entry.before ?? '未安装'} → ${entry.after ?? '未安装'}`}
                          </p>
                          {entry.changedFields?.length > 0 && (
                            <p className="wl-muted">
                              变化项：
                              {entry.changedFields
                                .map(
                                  (field: string) =>
                                    ({
                                      spec: '声明规格',
                                      version: '解析版本',
                                      kind: '安装方式',
                                      localSourceHash: '本地源码',
                                      target: '本地路径',
                                    })[field] ?? field,
                                )
                                .join('、')}
                            </p>
                          )}
                        </div>
                      ))
                  )}
                </details>
              ))}
            </>
          )}
        </>
      )}
    </Panel>
  )
}
