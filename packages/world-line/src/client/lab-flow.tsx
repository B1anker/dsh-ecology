import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { FileText } from '@phosphor-icons/react/dist/csr/FileText'
import { Flask } from '@phosphor-icons/react/dist/csr/Flask'
import { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple'
import { X } from '@phosphor-icons/react/dist/csr/X'
import { useEffect, useState } from 'react'
import type { LabActionResult, LabPromoteCommandResult } from '../commands/lab.js'
import type { ReportResult } from '../commands/report.js'
import type { RestoreCommandResult } from '../commands/restore.js'
import { failureSummary } from './failure-summary.js'
import { HudTabs } from './hud-controls.js'
import { installationToResume } from './installation-flow.js'
import { JobReceipt, jobKindLabel, ProbeLadder, useJob } from './job-view.js'
import { useLabStatus } from './lab-status.js'
import { localPluginPath, type PluginSource, pluginInstallSpec } from './plugin-input.js'
import { ReportView } from './report-view.js'

/** 「安装插件 → 验证 → promote」引导向导（web actions: lab-add / promote / restore / report / rescue-start）。 */
export function LabFlow({
  api,
  close,
  onBusy,
  onSettled,
  onLocate,
  onCompare,
  lastKnownGood,
  sourceName,
  sourceId,
}: {
  sourceId: string
  sourceName: string
  api(body: unknown, signal?: AbortSignal): Promise<any>
  close(): void
  onBusy(running: boolean): void
  onSettled(): void
  onCompare(id: string): void
  onLocate(id: string): void
  /** last-known-good 快照 id；为 null 时没有可回滚的稳定世界线。 */
  lastKnownGood: string | null
}) {
  const [step, setStep] = useState<'install' | 'verify' | 'result'>('install')
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState('')
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [spec, setSpec] = useState('')
  const [pluginSource, setPluginSource] = useState<PluginSource>('registry')
  const [localPath, setLocalPath] = useState('')
  const installInput = pluginInstallSpec(pluginSource, pluginSource === 'local' ? localPath : spec)
  const [promote, setPromote] = useState(false)
  const [restart, setRestart] = useState(true)
  const [keep, setKeep] = useState(true)
  const [allowScripts, setAllowScripts] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setRestoring(true)
    setRestoreError('')
    api({ action: 'jobs' })
      .then((jobs) => {
        if (disposed) return
        const resumed = installationToResume(jobs, sourceId)
        setJobId(resumed?.id ?? null)
        setStep(resumed ? 'verify' : 'install')
      })
      .catch(() => {
        if (!disposed) setRestoreError('无法读取这条世界线的任务，请重试。')
      })
      .finally(() => {
        if (!disposed) setRestoring(false)
      })
    return () => {
      disposed = true
    }
  }, [sourceId, restoreAttempt])
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [reportData, setReportData] = useState<ReportResult | null>(null)
  useEffect(() => setReportData(null), [jobId])
  const [message, setMessage] = useState('')

  const [confirmReview, setConfirmReview] = useState(false)
  useEffect(() => setConfirmReview(false), [jobId])
  const [confirmRollback, setConfirmRollback] = useState(false)
  const { job, gone, connectionError } = useJob(api, jobId, () => {
    onBusy(false)
    onSettled()
    setStep('result')
  })
  const result = job?.result as
    | (LabActionResult & Partial<LabPromoteCommandResult & RestoreCommandResult>)
    | undefined
  const labId =
    job?.kind === 'promote'
      ? ((result as LabPromoteCommandResult | undefined)?.labId ?? job?.labId ?? null)
      : (result?.labId ?? null)
  const { status: lab, error: labError } = useLabStatus(api, labId, `${job?.id}:${job?.status}`)
  const promoted =
    !!job &&
    job.status === 'ok' &&
    (job.kind === 'promote' || result?.promote !== undefined || result?.promoted === true)
  const begin = (nextJobId: string) => {
    setJobId(nextJobId)
    try {
      sessionStorage.setItem(`world-line:verification-job:${sourceId}`, nextJobId)
    } catch {}
    setStep('verify')
    setMessage('')
    setError('')
    onBusy(true)
  }
  const run = async (pendingText: string, body: Record<string, unknown>) => {
    if (pending) return
    setPending(pendingText)
    setError('')
    try {
      const outcome: { jobId: string } = await api(body)
      begin(outcome.jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务启动失败')
    } finally {
      setPending('')
    }
  }
  const report = async () => {
    if (pending || !labId) return
    setPending('正在生成诊断报告…')
    setError('')
    setMessage('')
    try {
      const outcome: ReportResult = await api({ action: 'report', id: labId })
      setReportData(outcome)
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成报告失败')
    } finally {
      setPending('')
    }
  }
  const failedProbes =
    job?.probes.filter(
      (probe) =>
        probe.status === 'fail' ||
        probe.status === 'inconclusive' ||
        (probe.required && probe.status === 'skip'),
    ) ?? []
  const failure = failureSummary(
    failedProbes,
    job?.error,
    (job?.result as LabActionResult | undefined)?.spec ?? spec,
  )
  return (
    <aside
      className="wl-inspector wl-lab-flow"
      aria-label="验证插件"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!pending) close()
        }
      }}
    >
      <header className="wl-header">
        <div>
          <span className="wl-eyebrow">LAB FLOW</span>
          <h2>安装并验证插件</h2>
        </div>
        <button
          className="wl-button wl-icon"
          aria-label="关闭验证向导"
          disabled={!!pending}
          onClick={close}
        >
          <X size={16} />
        </button>
      </header>
      {restoring && <p role="status">正在读取这条世界线的安装进度…</p>}
      {restoreError && (
        <p role="alert">
          {restoreError}{' '}
          <button className="wl-button" onClick={() => setRestoreAttempt((value) => value + 1)}>
            重试
          </button>
        </p>
      )}
      {!restoring && !restoreError && (
        <p className="wl-muted">
          {step === 'install'
            ? '第 1 步 · 安装候选'
            : step === 'verify'
              ? `第 2 步 · ${job ? jobKindLabel(job.kind) : '验证中'}`
              : '第 3 步 · 结果'}
        </p>
      )}
      {!restoring && !restoreError && step === 'install' && (
        <div className="wl-lab-form">
          <p>来源环境：{sourceName}。验证通过后合回此环境。</p>
          <HudTabs
            label="插件来源"
            value={pluginSource}
            onChange={(value) => {
              if (!pending) setPluginSource(value as PluginSource)
            }}
            items={[
              { id: 'registry', title: 'npm 包' },
              { id: 'local', title: '本地插件' },
            ]}
          />
          <label>
            {pluginSource === 'local' ? '插件文件夹路径' : '包名（可带版本）'}
            <input
              type="text"
              value={pluginSource === 'local' ? localPath : spec}
              onChange={(event) => {
                const value = event.target.value
                const pastedPath = localPluginPath(value)
                if (pluginSource === 'local') setLocalPath(value)
                else if (pastedPath !== null) {
                  setPluginSource('local')
                  setLocalPath(pastedPath)
                } else setSpec(value)
              }}
              placeholder={
                pluginSource === 'local'
                  ? '/Users/你的用户名/code/my-plugin'
                  : '@seaveyon/dsh-web-login 或 @seaveyon/dsh-web-login@0.5.0'
              }
              disabled={!!pending}
            />
          </label>
          <p className="wl-muted">
            {pluginSource === 'local'
              ? '选择运行 DSH 的电脑上的插件目录，目录内须有 package.json；将作为 file: 本地依赖在实验中安装。'
              : '不填版本默认安装 latest；填写 @版本号、@标签或版本范围可指定版本。'}
          </p>
          {installInput.error && (
            <p className="wl-error" role="alert">
              {installInput.error}
            </p>
          )}
          {installInput.spec && (
            <p className="wl-muted" style={{ overflowWrap: 'anywhere' }}>
              将安装：{installInput.spec}
            </p>
          )}
          <label className="wl-merge-config">
            <input
              type="checkbox"
              checked={promote}
              disabled={!!pending}
              onChange={(event) => setPromote(event.target.checked)}
            />
            验证通过后自动合入来源环境
          </label>
          <label
            className="wl-merge-config"
            title="合入时会短暂重启目标世界线，通过检查后记录可用恢复点"
          >
            <input
              type="checkbox"
              checked={restart}
              disabled={!!pending}
              onChange={(event) => setRestart(event.target.checked)}
            />
            合入后自动重启并检查
          </label>
          <label className="wl-merge-config">
            <input
              type="checkbox"
              checked={keep}
              disabled={!!pending}
              onChange={(event) => setKeep(event.target.checked)}
            />
            保留实验环境
          </label>
          <label className="wl-merge-config">
            <input
              type="checkbox"
              checked={allowScripts}
              disabled={!!pending}
              onChange={(event) => setAllowScripts(event.target.checked)}
            />
            允许构建脚本（默认忽略 install 脚本）
          </label>

          <p className="wl-muted">
            验证在独立实验环境中进行，来源环境保持运行。验证任务在后台执行，关闭此面板不会中断。
          </p>
          <button
            className="wl-button wl-primary"
            disabled={!installInput.spec || !!pending}
            onClick={() =>
              void run('正在提交验证任务…', {
                action: 'lab-add',
                sourceId,
                spec: installInput.spec,
                keep,
                allowScripts,
                promote,
                restart,
              })
            }
          >
            {pending ? <CircleNotch size={16} className="wl-spin" /> : <Flask size={16} />}
            开始安装与验证
          </button>
        </div>
      )}
      {step === 'verify' && (
        <>
          {job ? (
            <ProbeLadder job={job} onLogs={() => void report()} />
          ) : (
            <p className="wl-insight-loading" role="status">
              <CircleNotch size={18} className="wl-spin" />
              正在启动验证任务…
            </p>
          )}
          {gone && <p className="wl-muted">任务已结束，结果以世界线状态为准。</p>}
          <p className="wl-muted">关闭此面板不会中断任务；完成后时间线会自动刷新。</p>
        </>
      )}
      {step === 'result' && job && (
        <>
          {job.status === 'ok' &&
            (promoted ? (
              <>
                <JobReceipt job={job} />
                <button className="wl-button wl-primary" onClick={close}>
                  返回时间线
                </button>
              </>
            ) : (
              <div className="wl-event-detail">
                <span className="wl-eyebrow">VERIFIED</span>
                <h3>{lab?.canPromote ? '验证通过，尚未合入' : '基础检查完成，待浏览器验证'}</h3>
                {labId ? (
                  <>
                    <p className="wl-muted">
                      {lab?.name ?? labId} 已保留，来源为 {lab?.sourceName ?? sourceName}
                      。它是验证用的临时副本，验证后进程已停止；保留配置不代表实例正在运行。
                    </p>
                    <button className="wl-button" onClick={() => onLocate(labId)}>
                      在画布中定位此实验
                    </button>
                    {!lab?.canPromote && (
                      <button
                        className="wl-button wl-primary"
                        disabled={!!pending || !lab}
                        onClick={() =>
                          void run('正在补做浏览器验证…', {
                            action: 'lab-verify',
                            id: labId,
                            interactive: true,
                          })
                        }
                      >
                        登录并补做浏览器验证
                      </button>
                    )}
                    <p className="wl-muted">
                      合入会把实验里验证过的插件和配置应用到来源环境（
                      {lab?.sourceName ?? sourceName}）。浏览器验证通过后才能执行。
                    </p>
                    {labError && <p className="wl-error">{labError}</p>}
                    <button
                      className="wl-button wl-primary"
                      disabled={!!pending || !lab?.canPromote}
                      onClick={() =>
                        void run('正在提交合入…', {
                          action: 'promote',
                          id: labId,
                          restart,
                        })
                      }
                    >
                      <UploadSimple size={15} />
                      确认合入来源环境
                    </button>
                  </>
                ) : (
                  <p className="wl-muted">实验环境已清理，无法单独合入。</p>
                )}
                <button className="wl-button" onClick={close}>
                  返回时间线
                </button>
              </div>
            ))}
          {['fail', 'review', 'awaiting_auth', 'incomplete'].includes(job.status) && (
            <div className="wl-event-detail">
              <span className="wl-eyebrow">
                {job.status === 'fail' ? 'BLOCKED' : job.status === 'review' ? 'REVIEW' : 'PENDING'}
              </span>
              <h3>
                {job.status === 'fail'
                  ? '发现阻断问题'
                  : job.status === 'awaiting_auth'
                    ? '等待登录后继续'
                    : job.status === 'review'
                      ? '运行异常待确认'
                      : '验证尚未完成'}
                ，来源环境未改动
              </h3>
              <div className="wl-failure-summary">
                <strong>{failure.title}</strong>
                <p>{failure.next}</p>
              </div>
              <details>
                <summary>技术详情（{failedProbes.length} 项检查，重复原因已合并）</summary>
                {failure.details.map((detail, index) => (
                  <p key={index} className="wl-muted">
                    {detail}
                  </p>
                ))}
              </details>
              {job.status === 'review' && (
                <section className="wl-review-action" aria-label="人工确认合入">
                  <strong>人工确认后合入</strong>
                  <p className="wl-muted">
                    只有必要检查通过时可接受本次未确认风险。该选择会留下记录，不自动标记稳定点，也不适用于后续安装。
                  </p>
                  <button
                    className="wl-button wl-primary"
                    disabled={!!pending || !labId}
                    onClick={() => {
                      if (!confirmReview) {
                        setConfirmReview(true)
                        return
                      }
                      void run('正在记录本次风险接受并合入…', {
                        action: 'promote',
                        id: labId,
                        acceptReview: true,
                        restart: false,
                      })
                    }}
                  >
                    {confirmReview ? '确认接受本次风险并合入' : '我已确认可用，继续合入'}
                  </button>
                  {confirmReview && (
                    <button className="wl-button" onClick={() => setConfirmReview(false)}>
                      取消合入
                    </button>
                  )}
                </section>
              )}
              <div className="wl-flow-actions">
                {failure.login && (
                  <>
                    <button
                      className="wl-button wl-primary"
                      disabled={!!pending || !labId}
                      onClick={() =>
                        void run('正在打开本机验证浏览器…', {
                          action: 'lab-verify',
                          id: labId,
                          interactive: true,
                        })
                      }
                    >
                      打开本机验证浏览器并继续
                    </button>
                    <p className="wl-muted">
                      点击后将在运行 DSH
                      的这台电脑打开验证窗口。支持会话交接时自动继续；旧分支的登录组件可能仍需登录。无需重新安装插件。
                    </p>
                  </>
                )}
                <button
                  className="wl-button"
                  disabled={!!pending || !labId}
                  onClick={() => void run('正在重验当前实验…', { action: 'lab-verify', id: labId })}
                >
                  重验当前实验
                </button>
                <button
                  className="wl-button"
                  disabled={!!pending || !labId}
                  onClick={() => void report()}
                >
                  <FileText size={15} />
                  查看诊断报告
                </button>
                <details>
                  <summary>更多处理方式</summary>
                  <button
                    className="wl-button"
                    disabled={!!pending}
                    onClick={() => {
                      setStep('install')
                      setJobId(null)
                      try {
                        sessionStorage.removeItem(`world-line:verification-job:${sourceId}`)
                      } catch {}
                    }}
                  >
                    修改规格并重新安装
                  </button>
                  <details open={failure.login}>
                    <summary>登录与其他恢复方式</summary>
                    <button
                      className={failure.login ? 'wl-button wl-primary' : 'wl-button'}
                      disabled={!!pending || !labId}
                      onClick={() =>
                        void run('正在打开本机验证浏览器…', {
                          action: 'lab-verify',
                          id: labId,
                          interactive: true,
                        })
                      }
                    >
                      在本机浏览器中登录并重新验证
                    </button>
                    <p className="wl-muted">
                      优先复用本次管理操作的登录授权；若仍出现登录页，完成后自动继续。可跳过 API key
                      配置，本次不调用模型。
                    </p>
                    <button
                      className="wl-button"
                      disabled={!!pending || !labId}
                      onClick={() => void report()}
                    >
                      <FileText size={15} />
                      生成诊断报告
                    </button>
                  </details>
                  {(lab?.sourceId ?? sourceId) === 'origin' &&
                    (lastKnownGood === null ? (
                      <>
                        <button
                          className="wl-button"
                          disabled
                          title="还没有稳定世界线：先跑一次合入并完成重启验证 建立基线"
                        >
                          <ArrowCounterClockwise size={15} />
                          回滚到稳定世界线
                        </button>
                        <p className="wl-muted">
                          还没有稳定世界线：先跑一次合入并完成重启验证 建立基线。
                        </p>
                      </>
                    ) : confirmRollback ? (
                      <div className="wl-flow-actions-row">
                        <button
                          className={failure.login ? 'wl-button wl-primary' : 'wl-button'}
                          disabled={!!pending}
                          onClick={() => {
                            setConfirmRollback(false)
                            void run('正在启动回滚…', {
                              action: 'restore',
                              lastKnownGood: true,
                              promote: true,
                              restart,
                            })
                          }}
                        >
                          确认回滚
                        </button>
                        <button
                          className="wl-button"
                          disabled={!!pending}
                          onClick={() => setConfirmRollback(false)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        className="wl-button"
                        disabled={!!pending}
                        onClick={() => setConfirmRollback(true)}
                      >
                        <ArrowCounterClockwise size={15} />
                        回滚到稳定世界线
                      </button>
                    ))}
                </details>
              </div>
            </div>
          )}
          {['error', 'interrupted'].includes(job.status) && (
            <div className="wl-event-detail">
              <span className="wl-eyebrow">ERROR</span>
              <h3>任务异常结束</h3>
              <p className="wl-error">{job.error ?? '未知错误'}</p>
              {labId && (
                <>
                  <button className="wl-button" onClick={() => onLocate(labId)}>
                    在画布中定位此实验
                  </button>
                  <button
                    className="wl-button"
                    disabled={!!pending}
                    onClick={() =>
                      void run('正在重新验证…', {
                        action: 'lab-verify',
                        id: labId,
                        interactive: true,
                      })
                    }
                  >
                    登录并补做浏览器验证
                  </button>
                </>
              )}
              <div className="wl-toolbar">
                <button
                  className="wl-button"
                  disabled={!!pending}
                  onClick={() => {
                    setJobId(null)
                    try {
                      sessionStorage.removeItem(`world-line:verification-job:${sourceId}`)
                    } catch {}
                    setStep('install')
                  }}
                >
                  重新安装
                </button>
                <button className="wl-button" onClick={close}>
                  返回时间线
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {step === 'result' && !job && (
        <>
          <p className="wl-muted">任务已结束，结果以世界线状态为准。</p>
          <button className="wl-button" onClick={close}>
            返回时间线
          </button>
        </>
      )}
      {step === 'result' && (
        <button
          className="wl-button"
          disabled={!!pending}
          onClick={() => {
            setJobId(null)
            setStep('install')
            setError('')
            setMessage('')
            try {
              sessionStorage.removeItem(`world-line:verification-job:${sourceId}`)
            } catch {}
          }}
        >
          开始新的安装验证
        </button>
      )}
      {message && (
        <div className="wl-alert wl-success" role="status">
          <span>{message}</span>
        </div>
      )}
      {connectionError && (
        <p className="wl-error" role="status">
          {connectionError}
        </p>
      )}
      {pending && (
        <p className="wl-insight-loading" role="status">
          <CircleNotch size={18} className="wl-spin" />
          {pending}
        </p>
      )}
      {error && (
        <div className="wl-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {labId && job && !['queued', 'running'].includes(job.status) && (
        <button className="wl-button" onClick={() => onCompare(labId)}>
          查看相对验证前的差异
        </button>
      )}
      {reportData && <ReportView report={reportData} />}
    </aside>
  )
}
