import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReportResult } from '../commands/report.js'
import type { WorldEvent } from '../domain/insight-types.js'
import type { ApiFn } from './api-types.js'
import { errorMessage, useApiQuery } from './async.js'
import { ErrorText } from './error-text.js'
import { HudSelect } from './hud-controls.js'
import { useJobFeed } from './job-feed.js'
import { type Job, jobKindLabel } from './job-view.js'
import { Panel } from './panel.js'
import type { ToolPanel } from './panels.js'
import { PluginList } from './plugin-list.js'
import { RecoveryPanel } from './recovery-panel.js'
import { ReportView } from './report-view.js'
import { ResearchPanel } from './research-panel.js'
import { ChangeSummary, VersionPair } from './result-visuals.js'
import { jobStatusText } from './status-text.js'
import { StoragePanel } from './storage-panel.js'
import { type Line, label } from './timeline-model.js'
import { jobResearchTopic, researchGoals } from './workflow-navigation.js'

export function WorkspaceTools({
  panel,
  lines,
  events,
  api,
  close,
  navigate,
  onJob,
  onCompareLines,
  onSnapshot,
}: {
  panel: ToolPanel
  lines: Line[]
  events: WorldEvent[]
  api: ApiFn
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
  const [actionError, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [candidate, setCandidate] = useState<{
    action: string
    name: string
    spec: string
  } | null>(null)
  const [text, setText] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('current')
  const [diff, setDiff] = useState<any>(null)
  const panelScope = JSON.stringify([panel.section, panel.id, panel.lineId, panel.researchTopic])
  const actionScope = JSON.stringify([panelScope, candidate?.action, candidate?.name])
  const lifecycle = useRef({
    mounted: false,
    scope: actionScope,
    version: 0,
  })
  const operationVersion = useRef(0)
  if (lifecycle.current.scope !== actionScope) {
    lifecycle.current.scope = actionScope
    lifecycle.current.version += 1
  }
  useLayoutEffect(() => {
    lifecycle.current.mounted = true
    return () => {
      lifecycle.current.mounted = false
      lifecycle.current.version += 1
    }
  }, [])
  useEffect(() => setBusy(false), [actionScope])
  const currentScope = () => {
    const version = lifecycle.current.version
    return () => lifecycle.current.mounted && lifecycle.current.version === version
  }
  const beginOperation = () => {
    const inScope = currentScope()
    const version = ++operationVersion.current
    return () => inScope() && operationVersion.current === version
  }
  const source = lines.find((l) => l.id === panel.id)
  const workflowSource =
    source?.kind === 'verification'
      ? (source.parentId ?? 'origin')
      : panel.id.startsWith('snap-')
        ? (panel.lineId ?? 'origin')
        : panel.id
  const title = {
    composition: '插件列表',
    compare: '历史比较',
    config: '验证配置变更',
    report: '诊断报告',
    tasks: '任务台',
    storage: '存储',
    recovery: '修复未完成的操作',
    research: researchGoals[panel.researchTopic ?? 'diagnose'].title,
  }[panel.section]
  useEffect(() => {
    setCandidate(null)
    setDiff(null)
    setError('')
  }, [panelScope, api, source?.kind])
  const { data, error: loadError } = useApiQuery<any>(
    api,
    panel.section === 'composition'
      ? { action: 'composition', id: panel.id }
      : panel.section === 'compare'
        ? source?.kind === 'verification'
          ? { action: 'lab-diff', id: panel.id }
          : { action: 'snapshot-list', id: panel.id }
        : panel.section === 'report'
          ? {
              action: 'report',
              id: panel.id,
              ...(panel.lineId ? { lineId: panel.lineId } : {}),
            }
          : null,
    [panelScope, source?.kind],
    {
      fallback: '读取失败',
      onSuccess: (x) => {
        if (panel.section !== 'compare') return
        if (source?.kind === 'verification') {
          setDiff(x)
        } else {
          const latest = (x as WorldEvent[])
            .filter((event) => event.snapshotId)
            .toSorted((a, b) => b.at.localeCompare(a.at))[0]
          setFrom(latest?.snapshotId ?? '')
          setTo('current')
        }
      },
    },
  )
  const error = actionError || loadError
  const run = async (body: unknown) => {
    const current = beginOperation()
    setBusy(true)
    setError('')
    try {
      const r = await api(body)
      if (current()) onJob(r.jobId)
    } catch (e) {
      if (current()) setError(errorMessage(e, '操作失败'))
    } finally {
      if (current()) setBusy(false)
    }
  }
  const ref = (id: string) => ({
    lineId: panel.id,
    kind: id === 'current' ? 'current' : 'snapshot',
    ...(id === 'current' ? {} : { snapshotId: id }),
  })
  return (
    <Panel
      title={
        candidate
          ? candidate.action === 'lab-remove'
            ? '卸载插件'
            : candidate.action === 'lab-add'
              ? '验证本地更新'
              : '更换版本'
          : title
      }
      close={close}
      className="wl-inspector"
      aria-label={title}
      back={
        candidate
          ? () => {
              setCandidate(null)
              setError('')
            }
          : undefined
      }
      footer={
        candidate ? (
          <>
            <button
              className="wl-button"
              disabled={busy}
              onClick={() => {
                setCandidate(null)
                setError('')
              }}
            >
              返回插件列表
            </button>
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
              {busy ? '正在创建实验…' : candidate.action === 'lab-remove' ? '验证卸载' : '开始验证'}
            </button>
          </>
        ) : undefined
      }
    >
      {panel.section === 'tasks' ? (
        <p className="wl-muted">全部环境的任务 · 每条记录标明操作对象</p>
      ) : panel.section === 'research' && panel.researchTopic === 'deployment' ? (
        <p className="wl-muted">当前 profile 的外部部署 · 切换影响外部启动器运行的版本</p>
      ) : (
        <p>环境：{source ? label(source) : panel.id === 'origin' ? 'main' : panel.id}</p>
      )}
      {error && <ErrorText message={error} />}
      {panel.section === 'research' && (
        <ResearchPanel
          key={`${panel.id}:${panel.researchTopic ?? 'diagnose'}`}
          events={events}
          initialTopic={panel.researchTopic ?? 'diagnose'}
          id={panel.id}
          api={api}
          onJob={onJob}
        />
      )}
      {panel.section === 'recovery' && (
        <RecoveryPanel
          key={panel.id}
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
              const current = currentScope()
              if ('Notification' in window) {
                const permission = await Notification.requestPermission()
                if (current())
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
            <article className="wl-event-detail wl-task-card" data-status={job.status} key={job.id}>
              <strong>{jobKindLabel(job.kind)}</strong>
              <span className="wl-task-state">{jobStatusText(job.status)}</span>
              <small className="wl-task-source">
                环境：{(() => {
                  const id = job.resource ?? job.labId
                  const line = lines.find((item) => item.id === id)
                  return line ? label(line) : id === 'origin' ? 'main' : (id ?? '未记录')
                })()}
              </small>
              <time dateTime={job.startedAt}>{new Date(job.startedAt).toLocaleString()}</time>
              {job.error && <p className="wl-error">{job.error}</p>}
              <button className="wl-button" onClick={() => onJob(job.id)}>
                查看进度与结果
              </button>
              {(job.labId || jobResearchTopic(job.kind)) && (
                <details className="wl-task-details">
                  <summary>报告与相关记录</summary>
                  {jobResearchTopic(job.kind) && (
                    <button
                      className="wl-button"
                      onClick={() =>
                        navigate({
                          section: 'research',
                          id: job.resource ?? 'origin',
                          researchTopic: jobResearchTopic(job.kind),
                        })
                      }
                    >
                      查看{researchGoals[jobResearchTopic(job.kind)!].title}记录
                    </button>
                  )}
                  {job.labId && (
                    <>
                      <button
                        className="wl-button"
                        onClick={() => navigate({ section: 'report', id: job.labId! })}
                      >
                        验证报告
                      </button>
                      <button
                        className="wl-button"
                        onClick={() => navigate({ section: 'compare', id: job.labId! })}
                      >
                        实验与来源的差异
                      </button>
                    </>
                  )}
                </details>
              )}
            </article>
          ))}
          {allJobs.length >= 200 && (
            <button
              className="wl-button"
              disabled={busy}
              onClick={async () => {
                const current = beginOperation()
                setBusy(true)
                try {
                  const more = await api({
                    action: 'jobs',
                    before: allJobs.at(-1)?.id,
                  })
                  if (!current()) return
                  setOlderJobs((previous) => [...previous, ...more])
                  if (!more.length) setError('已显示全部保留任务')
                } catch (e) {
                  if (current()) setError(String(e))
                } finally {
                  if (current()) setBusy(false)
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
          {!data && !error && <p role="status">正在读取插件列表…</p>}
          <div hidden={!!candidate}>
            {data && (
              <PluginList
                plugins={data.dependencies ?? []}
                onChange={(plugin, remove) =>
                  setCandidate({
                    action: remove
                      ? 'lab-remove'
                      : plugin.kind === 'file' || plugin.kind === 'link'
                        ? 'lab-add'
                        : 'lab-update',
                    name: plugin.name,
                    spec: remove
                      ? plugin.name
                      : plugin.kind === 'file' || plugin.kind === 'link'
                        ? plugin.spec
                        : `${plugin.name}@`,
                  })
                }
              />
            )}
          </div>
          {candidate && (
            <div
              className="wl-plugin-action-page"
              tabIndex={-1}
              ref={(element) => {
                if (element && element.parentElement) element.parentElement.scrollTop = 0
              }}
            >
              <strong>{candidate.name}</strong>
              <p>
                先在独立实验中{candidate.action === 'lab-remove' ? '验证卸载后的情况' : '验证更新'}
                ，不会直接修改 {source ? label(source) : panel.id}。
              </p>
              {candidate.action !== 'lab-remove' && (
                <label>
                  {candidate.action === 'lab-add' ? '本地安装来源' : '目标版本（包名@版本号）'}
                  <input
                    autoFocus
                    value={candidate.spec}
                    onChange={(e) => setCandidate({ ...candidate, spec: e.target.value })}
                  />
                </label>
              )}
            </div>
          )}
          <details className="wl-plugin-maintenance" hidden={!!candidate}>
            <summary>变更记录与维护</summary>
            {data?.drift && (
              <p>
                {data.drift.latest.status === 'changed'
                  ? '插件或配置与上次记录不同。'
                  : data.drift.latest.status === 'same'
                    ? '插件和配置与上次记录一致。'
                    : data.drift.latest.status === 'missing'
                      ? '还没有可比较的历史记录。'
                      : '暂时无法比较历史记录。'}
                {data.drift.lastKnownGood.status === 'missing' ? '尚未保存验证通过的恢复点。' : ''}
              </p>
            )}
            <p className="wl-muted">记录不同不代表出错，需要时可查看具体差异。</p>
            {data?.warnings?.map((warning: string, i: number) => (
              <p className="wl-error" key={i}>
                {warning}
              </p>
            ))}
            <div className="wl-flow-actions-row">
              <button
                className="wl-button"
                onClick={() => navigate({ section: 'compare', id: panel.id })}
              >
                查看变更
              </button>
              <button
                className="wl-button"
                onClick={() => navigate({ section: 'config', id: panel.id })}
              >
                验证配置修改
              </button>
              <button
                className="wl-button"
                onClick={() => navigate({ section: 'recovery', id: workflowSource })}
              >
                修复未完成的操作
              </button>
              <button
                className="wl-button"
                onClick={() => navigate({ section: 'research', id: workflowSource })}
              >
                排查问题
              </button>
            </div>
          </details>
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
                      operationVersion.current += 1
                      side.set(e.target.value)
                      setDiff(null)
                      setError('')
                      setBusy(false)
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
                  const current = beginOperation()
                  setBusy(true)
                  setError('')
                  try {
                    const result = await api({
                      action: 'snapshot-compare',
                      from: ref(from),
                      to: ref(to),
                    })
                    if (current()) setDiff(result)
                  } catch (e) {
                    if (current()) setError(String(e))
                  } finally {
                    if (current()) setBusy(false)
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
              <ChangeSummary
                diff={{
                  dependencies: diff.diff.dependencies ?? [],
                  files: diff.diff.files ?? [],
                  patches: diff.diff.patches ?? [],
                }}
              />
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
                          </p>
                          {k === 'dependencies' && (
                            <VersionPair before={entry.before} after={entry.after} />
                          )}
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
