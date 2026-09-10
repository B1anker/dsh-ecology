import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEvent } from '../domain/insight-types.js'
import { BackupSelect } from './backup-select.js'
import { HudSelect, HudTabs } from './hud-controls.js'
import type { Job } from './job-view.js'
import { CompatibilityMatrix, UpgradeResults } from './result-visuals.js'
import type { ResearchTopic } from './workflow-navigation.js'

export function ResearchPanel({
  id,
  api,
  onJob,
  events,
  initialTopic = 'diagnose',
}: {
  id: string
  api(body: unknown): Promise<any>
  onJob(id: string): void
  events: WorldEvent[]
  initialTopic?: ResearchTopic
}) {
  const [matrixJobs, setMatrixJobs] = useState<Job[]>([])
  const [matrixError, setMatrixError] = useState('')
  const topic = initialTopic
  const [diagnosisTab, setDiagnosisTab] = useState('new')
  const [refreshMessage, setRefreshMessage] = useState('')
  const [diagnosisMethod, setDiagnosisMethod] = useState('plugins')
  const [exportSnapshot, setExportSnapshot] = useState('')
  const [loading, setLoading] = useState(false)
  const scope = useRef('')
  scope.current = `${id}:${topic}`
  const loadVersion = useRef(0)
  const viewVersion = useRef(0)
  const bundleVersion = useRef(0)
  const [historyLimit, setHistoryLimit] = useState(5)
  const [breakStale, setBreakStale] = useState(false)
  const [interruptedConfirmations, setInterruptedConfirmations] = useState<
    Record<string, { accepted?: boolean; breakStale?: boolean }>
  >({})
  const [promoteLab, setPromoteLab] = useState<string | null>(null)
  const [entry, setEntry] = useState<{ id: string; url: string } | null>(null)
  const [sessions, setSessions] = useState<any[]>([]),
    [snapshots, setSnapshots] = useState<any[]>([]),
    [good, setGood] = useState(''),
    [bad, setBad] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState(''),
    [policy, setPolicy] = useState<any>(null),
    [upgrades, setUpgrades] = useState<any[]>([]),
    [deployment, setDeployment] = useState<any>(null),
    [lab, setLab] = useState(''),
    [accepted, setAccepted] = useState(false)
  const [bundle, setBundle] = useState(''),
    [requirements, setRequirements] = useState<Record<string, string>>({})
  const refresh = useCallback(
    async (manual = false) => {
      const expectedScope = `${id}:${topic}`
      const version = ++loadVersion.current
      const current = () => scope.current === expectedScope && loadVersion.current === version
      setLoading(true)
      setError('')
      setRefreshMessage('')
      setPromoteLab(null)
      setInterruptedConfirmations({})
      try {
        if (topic === 'diagnose') {
          const [records, points] = await Promise.all([
            api({ action: 'investigations' }),
            api({ action: 'snapshot-list', id }),
          ])
          if (!current()) return
          setSessions(records.filter((record: any) => record.sourceId === id))
          setSnapshots(points.filter((point: any) => point.snapshotId))
          if (manual)
            setRefreshMessage(
              `已重新读取 ${records.filter((record: any) => record.sourceId === id).length} 条排查记录、${points.filter((point: any) => point.snapshotId).length} 份备份 · ${new Date().toLocaleTimeString()}`,
            )
        } else if (topic === 'transfer') {
          const points = await api({ action: 'snapshot-list', id })
          if (!current()) return
          setSnapshots(points.filter((point: any) => point.snapshotId))
        } else if (topic === 'updates') {
          const [nextPolicy, results, jobs] = await Promise.all([
            api({ action: 'upgrade-policy', id }),
            api({ action: 'upgrade-results' }),
            api({ action: 'jobs' }).catch(() => null),
          ])
          if (!current()) return
          setPolicy(nextPolicy)
          setUpgrades(results.filter((result: any) => result.sourceId === id))
          setMatrixError(jobs === null ? '兼容验证历史读取失败，请刷新重试。' : '')
          if (jobs)
            setMatrixJobs(
              jobs.filter((job: Job) => job.kind === 'version-matrix' && job.resource === id),
            )
        } else {
          const status = await api({ action: 'deployment-status' })
          if (!current()) return
          setDeployment(status)
        }
        if (manual && current() && topic !== 'diagnose')
          setRefreshMessage(`数据已更新 · ${new Date().toLocaleTimeString()}`)
      } catch (e) {
        if (current()) setError(e instanceof Error ? e.message : '读取失败，请重试。')
      } finally {
        if (current()) setLoading(false)
      }
    },
    [api, id, topic],
  )
  useEffect(() => {
    setAccepted(false)
    setBreakStale(false)
    setPromoteLab(null)
    setInterruptedConfirmations({})
    setEntry(null)
    setError('')
    void refresh()
    return () => {
      loadVersion.current += 1
      viewVersion.current += 1
      bundleVersion.current += 1
    }
  }, [refresh])
  useEffect(() => {
    setGood('')
    setBad('')
    setExportSnapshot('')
    setSnapshots([])
    setSessions([])
    setPolicy(null)
    setUpgrades([])
    setMatrixJobs([])
    setMatrixError('')
    setDeployment(null)
    setLab('')
    setHistoryLimit(5)
    setDiagnosisTab('new')
  }, [id])
  const act = async (body: object) => {
    const expectedScope = scope.current
    const expectedVersion = viewVersion.current
    const current = () => scope.current === expectedScope && viewVersion.current === expectedVersion
    setBusy(true)
    setError('')
    try {
      const r = await api(body)
      if (!current()) return
      if (r.jobId) onJob(r.jobId)
      else {
        await refresh()
        if (current() && (body as { action?: string }).action === 'investigation-create')
          setDiagnosisTab('records')
      }
      return current() ? r : undefined
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  const download = (value: unknown, name: string) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  let required: string[] = []
  try {
    required = JSON.parse(bundle).requiredFiles ?? []
  } catch {}
  return (
    <div className="wl-flow-actions wl-workflow-body">
      <p className="wl-workflow-intro">
        {
          {
            diagnose: '查找导致问题的插件或历史变更。排查在独立环境中进行，不影响当前使用。',
            transfer: '带走一套可复现的配置。在目标电脑补充秘密，再验证是否适用。',
            updates: '先确认兼容，再决定升级。验证结果不会直接替换你正在使用的环境。',
            deployment: '把已验证环境保留为完整部署。准备、切换、启用守护是三个明确步骤。',
          }[topic]
        }
      </p>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      {topic === 'diagnose' && (
        <HudTabs
          label="排查功能"
          value={diagnosisTab}
          onChange={(value) => {
            setDiagnosisTab(value)
            setRefreshMessage('')
          }}
          items={[
            { id: 'new', title: '新建排查' },
            { id: 'records', title: `排查记录（${sessions.length}）` },
          ]}
        />
      )}
      {(topic !== 'diagnose' ||
        diagnosisTab === 'records' ||
        diagnosisMethod === 'time' ||
        error) && (
        <>
          <button
            className="wl-button"
            disabled={busy || loading}
            onClick={() => void refresh(true)}
          >
            {loading
              ? '正在读取…'
              : {
                  diagnose: diagnosisTab === 'records' ? '刷新排查记录' : '刷新备份列表',
                  transfer: '刷新备份列表',
                  updates: '刷新升级结果',
                  deployment: '刷新部署状态',
                }[topic]}
          </button>
          {refreshMessage && (
            <p className="wl-muted" role="status">
              {refreshMessage}
            </p>
          )}
        </>
      )}
      <section hidden={topic !== 'diagnose' || diagnosisTab !== 'new'} className="wl-event-detail">
        <h3>选择问题定位方式</h3>
        <label>
          你掌握哪些线索？
          <HudSelect value={diagnosisMethod} onChange={(e) => setDiagnosisMethod(e.target.value)}>
            <option value="plugins">不知道何时出错，先排查当前插件</option>
            <option value="time">从历史备份查找问题</option>
          </HudSelect>
        </label>
        {diagnosisMethod === 'time' ? (
          <>
            <p>选择一份可正常使用的备份和一份需要排查的备份，系统会在这段历史中查找问题原因。</p>
            {!loading && snapshots.length < 2 && (
              <p className="wl-muted">
                {snapshots.length === 0
                  ? '还没有可用的历史备份。可以切换到“排查当前插件”，无需准备备份。'
                  : '至少需要两份历史备份才能比较。现在可以先排查当前插件。'}
              </p>
            )}
            <BackupSelect
              label="可正常使用的备份"
              value={good}
              onChange={setGood}
              points={snapshots}
              events={events}
              id={id}
              api={api}
              disabled={loading || snapshots.length < 2}
            />
            <BackupSelect
              label="需要排查的备份"
              value={bad}
              onChange={setBad}
              points={snapshots}
              events={events}
              id={id}
              api={api}
              disabled={loading || snapshots.length < 2}
            />
            {good && good === bad && <p className="wl-muted">请选择两份不同的备份。</p>}
            <button
              className="wl-button wl-primary"
              disabled={
                busy ||
                loading ||
                good === bad ||
                !snapshots.some((point) => point.snapshotId === good) ||
                !snapshots.some((point) => point.snapshotId === bad)
              }
              onClick={() =>
                void act({ action: 'investigation-create', kind: 'time', sourceId: id, good, bad })
              }
            >
              开始查找问题原因
            </button>
          </>
        ) : (
          <>
            <p>在隔离环境中逐组验证当前插件，缩小问题范围。无需历史快照。</p>
            <button
              className="wl-button wl-primary"
              disabled={busy}
              onClick={() =>
                void act({ action: 'investigation-create', kind: 'plugins', sourceId: id })
              }
            >
              开始排查当前插件
            </button>
          </>
        )}
      </section>
      {topic === 'diagnose' &&
        diagnosisTab === 'records' &&
        !loading &&
        !error &&
        !sessions.length && (
          <div className="wl-event-detail">
            <p>还没有排查记录。</p>
            <button className="wl-button" onClick={() => setDiagnosisTab('new')}>
              新建排查
            </button>
          </div>
        )}
      {topic === 'diagnose' && diagnosisTab === 'records' && (
        <p className="wl-muted">刷新只更新记录状态。要继续排查，请选择记录中的下一步操作。</p>
      )}
      {topic === 'diagnose' &&
        diagnosisTab === 'records' &&
        sessions.slice(0, historyLimit).map((s) => (
          <article className="wl-event-detail" key={s.id}>
            <strong>{s.kind === 'time' ? '按历史定位问题' : '排查当前插件'}</strong>
            <p>
              {s.id} ·{' '}
              {
                {
                  ready: '等待试验',
                  running: '验证中',
                  review: '等待判断',
                  complete: '定位完成',
                  inconclusive: '证据不足',
                }[s.status as string]
              }{' '}
              · 已完成 {s.trials.length} 次
            </p>
            <p>{s.note}</p>
            {s.active && (
              <>
                <p>
                  本步：{s.active.snapshotId ?? s.active.plugins?.join('、') ?? '仅核心'} ·{' '}
                  {s.active.labId}
                </p>
                {s.active.error && <p>{s.active.error}</p>}
              </>
            )}
            {s.status === 'ready' && (
              <>
                <button
                  className="wl-button"
                  disabled={busy}
                  onClick={() => void act({ action: 'investigation-run', id: s.id })}
                >
                  验证下一步并试用
                </button>
                <details className="wl-advanced">
                  <summary>自动判断（高级）</summary>
                  <p className="wl-muted">
                    适合页面无法启动等可自动检测的问题；需要人工体验的问题，请使用上方试用流程。
                  </p>
                  <button
                    className="wl-button"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: 'investigation-run', id: s.id, automatic: true })
                    }
                  >
                    按页面检查结果自动排查
                  </button>
                </details>
              </>
            )}
            {s.status === 'review' && (
              <>
                <button
                  className="wl-button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await act({ action: 'investigation-preview', id: s.id })
                    if (r?.url) setEntry(r)
                  }}
                >
                  启动本步试用副本
                </button>
                {entry && (
                  <a className="wl-button" href={entry.url} target="_blank" rel="noreferrer">
                    进入试用实例 {entry.id}
                  </a>
                )}
                <p>试用副本保留在画布中，可在那里停止。判断只记录本步结果。</p>
                <p>
                  探针建议：
                  {{ good: '正常', bad: '问题仍在', skip: '无法判断' }[
                    s.active?.suggested as string
                  ] ?? '等待探针'}
                  。请选择是否复现你遇到的问题。
                </p>
                <div className="wl-flow-actions-row">
                  {(['good', 'bad', 'skip'] as const).map((v, i) => (
                    <button
                      className="wl-button"
                      key={v}
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: 'investigation-answer',
                          id: s.id,
                          revision: String(s.revision),
                          verdict: v,
                        })
                      }
                    >
                      {['正常', '问题仍在', '跳过'][i]}
                    </button>
                  ))}
                </div>
              </>
            )}
            {s.status === 'running' && (
              <details className="wl-advanced">
                <summary>这一步已中断？</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={!!interruptedConfirmations[s.id]?.accepted}
                    onChange={(e) =>
                      setInterruptedConfirmations((previous) => ({
                        ...previous,
                        [s.id]: { ...previous[s.id], accepted: e.target.checked },
                      }))
                    }
                  />
                  我已确认这一步不再运行，允许处理其中断状态
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!!interruptedConfirmations[s.id]?.breakStale}
                    onChange={(e) =>
                      setInterruptedConfirmations((previous) => ({
                        ...previous,
                        [s.id]: { ...previous[s.id], breakStale: e.target.checked },
                      }))
                    }
                  />
                  允许清理已确认死亡进程的失效锁；活动进程仍受保护
                </label>
                <button
                  className="wl-button"
                  disabled={busy || !interruptedConfirmations[s.id]?.accepted}
                  onClick={() =>
                    void act({
                      action: 'investigation-skip-interrupted',
                      id: s.id,
                      breakStale: !!interruptedConfirmations[s.id]?.breakStale,
                    })
                  }
                >
                  处理已中断的这一步
                </button>
              </details>
            )}
            {!!s.candidates.length && <pre>{s.candidates.join('\n')}</pre>}
          </article>
        ))}
      {topic === 'diagnose' && diagnosisTab === 'records' && sessions.length > historyLimit && (
        <button className="wl-button" onClick={() => setHistoryLimit((n) => n + 5)}>
          再显示 5 条排障记录（剩余 {sessions.length - historyLimit}）
        </button>
      )}
      <section hidden={topic !== 'transfer'} className="wl-event-detail">
        <h3>导出和导入环境</h3>
        <label>
          要带走的快照
          <HudSelect
            aria-label="要导出的快照"
            value={exportSnapshot}
            disabled={loading || !snapshots.length}
            onChange={(e) => setExportSnapshot(e.target.value)}
          >
            <option value="">选择快照</option>
            {snapshots.map((s) => (
              <option key={s.snapshotId} value={s.snapshotId}>
                {s.title} · {new Date(s.at).toLocaleString()}
              </option>
            ))}
          </HudSelect>
        </label>
        {!loading && !snapshots.length && (
          <p className="wl-muted">
            尚无可导出的快照。先在画布保存当前快照，再来导出；导入已有环境包不受影响。
          </p>
        )}
        <p>
          导出包含受管配置与固定的本地插件源码，秘密文件只声明所需输入。导入先进入实验验证，通过后再手动合入。
        </p>
        <button
          className="wl-button"
          disabled={
            busy ||
            loading ||
            !exportSnapshot ||
            !snapshots.some((point) => point.snapshotId === exportSnapshot)
          }
          onClick={async () => {
            const value = await act({
              action: 'environment-export',
              id,
              snapshotId: exportSnapshot,
            })
            if (value) download(value, `${exportSnapshot}.world-line.json`)
          }}
        >
          导出所选快照
        </button>
        <label>
          选择环境包
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              const expectedScope = scope.current
              const expectedView = viewVersion.current
              const version = ++bundleVersion.current
              const current = () =>
                scope.current === expectedScope &&
                viewVersion.current === expectedView &&
                bundleVersion.current === version
              setAccepted(false)
              setRequirements({})
              setBundle('')
              setError('')
              if (!f) return
              if (f.size > 32 * 1024 * 1024) {
                setError('环境包超过 32 MiB')
                return
              }
              try {
                const text = await f.text()
                if (current()) {
                  setBundle(text)
                  setAccepted(false)
                }
              } catch (e) {
                if (current()) setError(e instanceof Error ? e.message : '环境包读取失败')
              }
            }}
          />
        </label>
        {required.map((name) => (
          <label key={name}>
            {name}（仅写入新实验）
            <textarea
              value={requirements[name] ?? ''}
              onChange={(e) => setRequirements({ ...requirements, [name]: e.target.value })}
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          已核对环境包和必要凭据，先导入隔离环境验证
        </label>
        <button
          className="wl-button wl-primary"
          disabled={busy || !accepted || !bundle || required.some((n) => !requirements[n])}
          onClick={() =>
            void act({
              action: 'environment-import',
              sourceId: id,
              bundleText: bundle,
              requiredFiles: requirements,
            })
          }
        >
          导入并验证
        </button>
      </section>
      <section hidden={topic !== 'updates'} className="wl-event-detail">
        <h3>检查插件升级</h3>
        <p>检查当前环境中的插件是否有新版本，并在隔离环境验证。通过后再由你决定是否合入。</p>
        <label>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          已核对来源环境，允许在隔离环境中检查和验证升级
        </label>
        <p>
          {policy?.enabled
            ? `已启用，每 ${policy.hours} 小时；下次 ${policy.nextAt}`
            : '周期检查已关闭'}
        </p>
        <button
          className="wl-button"
          disabled={busy || !accepted}
          onClick={() => void act({ action: 'upgrade-check', id })}
        >
          检查插件更新并验证
        </button>
        <button
          className="wl-button"
          disabled={busy || !accepted}
          onClick={() =>
            void act({ action: 'upgrade-policy', id, enabled: !policy?.enabled, hours: '24' })
          }
        >
          {policy?.enabled ? '关闭周期检查' : '启用每天检查'}
        </button>
        {upgrades.map((r: any) => (
          <div key={r.checkedAt}>
            <p>{r.checkedAt}</p>
            <UpgradeResults rows={r.rows} />
            {r.rows
              .filter((p: any) => p.status === 'verified')
              .map((p: any) => (
                <div key={p.name}>
                  <p>
                    {p.name} {p.from} → {p.to} · 已通过验证
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={promoteLab === p.labId}
                      disabled={busy || !p.labId}
                      onChange={(e) => setPromoteLab(e.target.checked ? p.labId : null)}
                    />
                    确认将 {p.name} {p.to} 合入来源环境，并重启验证
                  </label>
                  <button
                    className="wl-button"
                    disabled={busy || !p.labId || promoteLab !== p.labId}
                    onClick={() => void act({ action: 'promote', id: p.labId, restart: true })}
                  >
                    合入此升级并验证重启
                  </button>
                </div>
              ))}
          </div>
        ))}
      </section>
      {topic === 'updates' && (
        <details className="wl-advanced">
          <summary>验证指定 DSH 版本（高级）</summary>
          <section className="wl-event-detail">
            <h3>指定 DSH 版本兼容验证</h3>
            <p>
              用于计划更换 DSH
              版本时，提前验证现有插件是否兼容。每个版本安装到独立目录，不直接升级当前 DSH。
            </p>
            <input
              aria-label="精确宿主版本，以逗号分隔"
              value={versions}
              onChange={(e) => setVersions(e.target.value)}
              placeholder="0.1.2-rc.1, …"
            />
            <button
              className="wl-button"
              disabled={busy || !accepted || !versions.split(',').some((version) => version.trim())}
              onClick={() =>
                void act({
                  action: 'version-matrix',
                  sourceId: id,
                  versions: versions
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            >
              验证这些 DSH 版本
            </button>
          </section>
          {topic === 'updates' && (
            <>
              {matrixError && <p className="wl-error">{matrixError}</p>}
              {!matrixError && !matrixJobs.length && (
                <p className="wl-muted">
                  最近任务中暂无此环境的兼容验证记录。运行验证后，这里会显示版本矩阵。
                </p>
              )}
              {matrixJobs.slice(0, 5).map((job) => (
                <section className="wl-viz" key={job.id}>
                  <small>{new Date(job.startedAt).toLocaleString()}</small>
                  {(job.result as any)?.rows ? (
                    <CompatibilityMatrix rows={(job.result as any).rows} />
                  ) : (
                    <p>{job.phase || '尚无矩阵结果'}</p>
                  )}
                  {job.error && <p className="wl-error">{job.error}</p>}
                  <button className="wl-button" onClick={() => onJob(job.id)}>
                    查看验证任务
                  </button>
                </section>
              ))}
            </>
          )}
        </details>
      )}
      <section hidden={topic !== 'deployment'} className="wl-event-detail">
        <h3>独立部署与自动回退</h3>
        <label>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          已核对目标环境，允许下方明确选择的部署操作
        </label>
        <p>
          从已通过浏览器验证的实验准备完整部署。外部启动器运行选中的部署；切换只改变部署指针。连续启动失败时回到之前的已验证部署，不依赖故障实例里的
          Web 面板。
        </p>
        <input
          aria-label="部署来源实验编号"
          value={lab}
          onChange={(e) => setLab(e.target.value)}
          placeholder="lab-…"
        />
        <button
          className="wl-button"
          disabled={busy || !accepted || !lab}
          onClick={() => void act({ action: 'deployment-stage', id: lab })}
        >
          复制并验证部署
        </button>
        <p>
          当前：{deployment?.active ?? '未选择'}；稳定：{deployment?.stable ?? '无'}
        </p>
        <p>{deployment?.notice}</p>
        {deployment?.service?.error && <p className="wl-error">{deployment.service.error}</p>}
        {deployment?.slots.map((s: any) => (
          <div key={s.id}>
            <p>
              {s.id} · {s.verified ? '已验证' : '准备未完成'}
            </p>
            {s.verified && (
              <button
                className="wl-button"
                disabled={busy || !accepted}
                onClick={() => void act({ action: 'deployment-activate', id: s.id })}
              >
                切换到此部署
              </button>
            )}
          </div>
        ))}
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() => void act({ action: 'deployment-rollback' })}
        >
          回到上一已验证部署
        </button>
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() =>
            void act({ action: 'deployment-config', enabled: !deployment?.enabled, threshold: '3' })
          }
        >
          {deployment?.enabled ? '关闭自动回退' : '启用连续 3 次失败自动回退'}
        </button>
        <details className="wl-advanced">
          <summary>启动器的中断处理选项</summary>
          <label>
            <input
              type="checkbox"
              checked={breakStale}
              onChange={(e) => setBreakStale(e.target.checked)}
            />
            允许清理已确认死亡进程的失效锁；活动进程仍受保护
          </label>
        </details>
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() =>
            void act({
              action: 'deployment-service',
              breakStale,
              operation: deployment?.service?.running ? 'stop' : 'start',
            })
          }
        >
          {deployment?.service?.running ? '停止外部启动器' : '启动外部启动器'}
        </button>
        {deployment?.service?.ready?.url && (
          <a
            className="wl-button"
            href={deployment.service.ready.url}
            target="_blank"
            rel="noreferrer"
          >
            进入当前部署实例
          </a>
        )}
      </section>
    </div>
  )
}
