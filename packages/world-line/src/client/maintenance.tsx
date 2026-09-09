import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { FileText } from '@phosphor-icons/react/dist/csr/FileText'
import { Stethoscope } from '@phosphor-icons/react/dist/csr/Stethoscope'
import { useEffect, useState } from 'react'
import type { DoctorResult } from '../commands/doctor.js'
import type { ReportResult } from '../commands/report.js'
import { HudTabs } from './hud-controls.js'
import {
  JobReceipt,
  jobKindLabel,
  ProbeLadder,
  StatusMark,
  statusText,
  useJob,
} from './job-view.js'
import { useLabStatus } from './lab-status.js'
import { Panel } from './panel.js'
import { ReportView } from './report-view.js'

/** 维护面板：doctor 诊断、救援实例、回滚入口；进行中任务复用探针阶梯。 */
export function Maintenance({
  api,
  jobId: externalJob,
  close,
  onBusy,
  onSettled,
  onJobCreated,
  lastKnownGood,
}: {
  api(body: unknown, signal?: AbortSignal): Promise<any>
  jobId: string | null
  close(): void
  onBusy(running: boolean): void
  onSettled(): void
  onJobCreated(id: string): void
  /** last-known-good 快照 id；为 null 时没有可回滚的稳定世界线。 */
  lastKnownGood: string | null
}) {
  const [topic, setTopic] = useState('diagnose')
  const [internalJob, setInternalJob] = useState<string | null>(null)
  const activeJob = externalJob ?? internalJob
  const { job, gone, connectionError } = useJob(api, activeJob, () => {
    onBusy(false)
    onSettled()
  })
  const running = !!job && ['running', 'queued'].includes(job.status)
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [doctorError, setDoctorError] = useState('')
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [reportData, setReportData] = useState<ReportResult | null>(null)
  useEffect(() => setReportData(null), [activeJob])
  const [message, setMessage] = useState('')

  const [confirmRestore, setConfirmRestore] = useState(false)
  const [restoreRestart, setRestoreRestart] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    setChecking(true)
    setDoctorError('')
    void api({ action: 'doctor' }, controller.signal)
      .then((result: DoctorResult) => {
        if (!controller.signal.aborted) setDoctor(result)
        return undefined
      })
      .catch((e) => {
        if (!controller.signal.aborted) setDoctorError(e instanceof Error ? e.message : '诊断失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
  }, [api, revision])
  const rollback = async () => {
    if (pending) return
    setPending('正在启动回滚…')
    setError('')
    try {
      const outcome: { jobId: string } = await api({
        action: 'restore',
        lastKnownGood: true,
        promote: true,
        restart: restoreRestart,
      })
      setConfirmRestore(false)
      setInternalJob(outcome.jobId)
      onJobCreated(outcome.jobId)
      onBusy(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '回滚启动失败')
    } finally {
      setPending('')
    }
  }
  const reportJob = async (id: string) => {
    if (pending) return
    setPending('正在生成诊断报告…')
    setError('')
    setMessage('')
    try {
      const outcome: ReportResult = await api({ action: 'report', id })
      setReportData(outcome)
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成报告失败')
    } finally {
      setPending('')
    }
  }
  const runForLab = async (id: string, action: 'lab-verify' | 'promote', interactive = false) => {
    if (pending || running) return
    setPending('正在提交任务…')
    setError('')
    try {
      const result = await api({ action, id, interactive })
      setInternalJob(result.jobId)
      onJobCreated(result.jobId)
      onBusy(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务启动失败')
    } finally {
      setPending('')
    }
  }
  const targetLabId = (job?.result as { labId?: string } | undefined)?.labId ?? job?.labId ?? null
  const { status: labStatus, error: labStatusError } = useLabStatus(
    api,
    targetLabId,
    `${job?.id}:${job?.status}`,
  )
  const verifiedLabId =
    job?.status === 'ok' && job.kind === 'lab-verify' && labStatus?.canPromote
      ? (job.result as { labId: string }).labId
      : null
  const failedLabId =
    job && ['fail', 'review', 'awaiting_auth', 'incomplete'].includes(job.status)
      ? ((job.result as { labId?: string | null } | undefined)?.labId ?? job.labId ?? null)
      : null
  return (
    <Panel
      title="维护"
      close={close}
      closeDisabled={!!pending}
      className="wl-inspector wl-maintenance"
      aria-label="维护"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!pending) close()
        }
      }}
    >
      {activeJob && (
        <section className="wl-event-detail">
          <span className="wl-eyebrow">{job ? job.kind.toUpperCase() : 'JOB'}</span>
          <h3>{job ? jobKindLabel(job.kind) : '任务进度'}</h3>
          {job ? (
            <ProbeLadder job={job} onLogs={() => failedLabId && void reportJob(failedLabId)} />
          ) : (
            <p className="wl-insight-loading" role="status">
              <CircleNotch size={18} className="wl-spin" />
              正在连接任务…
            </p>
          )}
          {gone && <p className="wl-muted">任务已结束，结果以世界线状态为准。</p>}
          {job && job.status === 'ok' && <JobReceipt job={job} />}
          {labStatusError && <p className="wl-error">{labStatusError}</p>}
          {verifiedLabId && (
            <button
              className="wl-button wl-primary"
              disabled={!!pending || running}
              onClick={() => void runForLab(verifiedLabId, 'promote')}
            >
              确认合回来源环境
            </button>
          )}
          {job &&
            job.status === 'ok' &&
            job.kind === 'restore' &&
            !(job.result as { promoted?: boolean } | undefined)?.promoted && (
              <p className="wl-muted">快照验证通过，未合入正式环境。</p>
            )}
          {job && ['fail', 'review', 'awaiting_auth', 'incomplete'].includes(job.status) && (
            <>
              <p className="wl-error">验证未通过，正式环境未改动。</p>
              {failedLabId && (
                <div className="wl-flow-actions">
                  <button
                    className="wl-button"
                    disabled={!!pending}
                    onClick={() => void runForLab(failedLabId, 'lab-verify')}
                  >
                    重验当前实验
                  </button>
                  <button
                    className="wl-button"
                    disabled={!!pending}
                    onClick={() => void runForLab(failedLabId, 'lab-verify', true)}
                  >
                    登录后重验
                  </button>
                </div>
              )}
              {failedLabId && (
                <button
                  className="wl-button"
                  disabled={!!pending}
                  onClick={() => void reportJob(failedLabId)}
                >
                  <FileText size={15} />
                  生成诊断报告
                </button>
              )}
            </>
          )}
          {job && ['error', 'interrupted'].includes(job.status) && (
            <>
              <p className="wl-error">{job.error ?? '任务异常结束'}</p>
              {targetLabId && (
                <button
                  className="wl-button"
                  disabled={!!pending}
                  onClick={() => void runForLab(targetLabId, 'lab-verify', true)}
                >
                  登录并补做浏览器验证
                </button>
              )}
            </>
          )}
        </section>
      )}
      <HudTabs
        value={topic}
        onChange={setTopic}
        label="维护功能"
        items={[
          { id: 'diagnose', title: '健康诊断' },
          { id: 'restore', title: '恢复稳定点' },
        ]}
      />
      <section hidden={topic !== 'restore'} className="wl-event-detail">
        <span className="wl-eyebrow">ROLLBACK</span>
        <h3>回滚到稳定世界线</h3>
        <p className="wl-muted">
          将最近一次记录为稳定的快照（last-known-good）在验证实验中还原验证，通过后合入
          到正式环境。验证期间正式环境不受影响。
        </p>
        {lastKnownGood === null ? (
          <>
            <button
              className="wl-button"
              disabled
              title="还没有稳定世界线：先跑一次合入并完成重启验证 建立基线"
            >
              <ArrowCounterClockwise size={15} />
              回滚到稳定世界线
            </button>
            <p className="wl-muted">还没有稳定世界线：先跑一次合入并完成重启验证 建立基线。</p>
          </>
        ) : confirmRestore ? (
          <div className="wl-lab-form">
            <label className="wl-merge-config">
              <input
                type="checkbox"
                checked={restoreRestart}
                disabled={!!pending}
                onChange={(event) => setRestoreRestart(event.target.checked)}
              />
              合入后重启验证（记录新的稳定世界线）
            </label>
            <div className="wl-toolbar">
              <button
                className="wl-button wl-primary"
                disabled={!!pending || running}
                onClick={() => void rollback()}
              >
                {pending ? <CircleNotch size={16} className="wl-spin" /> : null}
                确认回滚
              </button>
              <button
                className="wl-button"
                disabled={!!pending}
                onClick={() => setConfirmRestore(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            className="wl-button"
            disabled={!!pending || running}
            onClick={() => setConfirmRestore(true)}
          >
            <ArrowCounterClockwise size={15} />
            回滚到稳定世界线
          </button>
        )}
      </section>
      <section hidden={topic !== 'diagnose'}>
        <div className="wl-toolbar">
          <h3>
            <Stethoscope size={16} aria-hidden="true" /> 环境诊断
          </h3>
          <button
            className="wl-button"
            disabled={checking}
            onClick={() => setRevision((value) => value + 1)}
          >
            <ArrowsClockwise size={15} className={checking ? 'wl-spin' : ''} />
            重新检查
          </button>
        </div>
        {!doctor && checking && (
          <p className="wl-insight-loading" role="status">
            <CircleNotch size={18} className="wl-spin" />
            正在诊断环境…
          </p>
        )}
        {doctor && (
          <>
            <p className="wl-muted">
              {doctor.summary.ok} 通过 · {doctor.summary.failed} 失败 · {doctor.summary.warned} 警告
              · {doctor.summary.skipped} 跳过
            </p>
            {doctor.checks.map((check) => (
              <div className="wl-diff-row" key={check.id}>
                <strong>{check.title}</strong>
                <span className="wl-status-text">
                  <StatusMark status={check.status} />
                  {statusText(check.status)}
                </span>
                {check.detail && <p>{check.detail}</p>}
              </div>
            ))}
          </>
        )}
        {doctorError && (
          <div className="wl-error" role="alert">
            <p>{doctorError}</p>
            <button className="wl-button" onClick={() => setRevision((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
      </section>

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
      {reportData && <ReportView report={reportData} />}
    </Panel>
  )
}
