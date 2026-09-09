import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { MinusCircle } from '@phosphor-icons/react/dist/csr/MinusCircle'
import { Question } from '@phosphor-icons/react/dist/csr/Question'
import { Warning } from '@phosphor-icons/react/dist/csr/Warning'
import { XCircle } from '@phosphor-icons/react/dist/csr/XCircle'
import { useEffect, useRef, useState } from 'react'
import type { LabActionResult, LabPromoteCommandResult } from '../commands/lab.js'
import type { RestoreCommandResult } from '../commands/restore.js'
import type { ProbeResult } from '../domain/probe.js'
import { jobsConnected, useJobFeed } from './job-feed.js'
import { CompatibilityMatrix } from './result-visuals.js'

/** Server-side job snapshot (web action `job`). Jobs are in-memory: a host restart loses them. */
export interface Job {
  id: string
  labId?: string
  resource?: string
  kind:
    | 'lab-add'
    | 'lab-update'
    | 'lab-remove'
    | 'lab-config-apply'
    | 'lab-verify'
    | 'promote'
    | 'restore'
    | 'deployment-stage'
    | 'investigate'
    | 'environment-import'
    | 'version-matrix'
    | 'upgrade-check'
  /** fail = 验证未通过（业务结果），error = 异常 */
  status:
    | 'queued'
    | 'running'
    | 'ok'
    | 'fail'
    | 'review'
    | 'awaiting_auth'
    | 'incomplete'
    | 'error'
    | 'interrupted'
  phase: string
  probes: ProbeResult[]
  result?: unknown
  error?: string
  startedAt: string
  finishedAt?: string
}

const KIND_LABEL: Record<string, string> = {
  'lab-add': '安装并验证插件',
  'lab-update': '升级并验证插件',
  'lab-remove': '卸载并验证插件',
  'lab-config-apply': '验证配置变更',
  'lab-verify': '重新验证实验',
  promote: '合入来源环境',
  restore: '回滚世界线',
  investigate: '后台二分排障',
  'deployment-stage': '准备并验证独立部署',
  'environment-import': '导入并验证环境',
  'version-matrix': '宿主版本兼容验证',
  'upgrade-check': '检查并验证升级',
}
export const jobKindLabel = (kind: string) => KIND_LABEL[kind] ?? kind

const STATUS_TEXT: Record<string, string> = {
  pass: '通过',
  ok: '通过',
  fail: '失败',
  review: '异常待确认',
  awaiting_auth: '等待登录',
  incomplete: '验证未完成',
  warn: '警告',
  inconclusive: '不确定',
  info: '提示',
  skip: '跳过',
}
export const statusText = (status: string) => STATUS_TEXT[status] ?? status

export function StatusMark({ status }: { status: string }) {
  const Icon =
    status === 'pass' || status === 'ok'
      ? CheckCircle
      : status === 'fail'
        ? XCircle
        : status === 'warn'
          ? Warning
          : status === 'inconclusive'
            ? Question
            : MinusCircle
  return (
    <span className="wl-mark" data-status={status} aria-hidden="true">
      <Icon size={15} />
    </span>
  )
}

const duration = (probe: ProbeResult) => {
  const ms = Date.parse(probe.finishedAt) - Date.parse(probe.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms >= 10000 ? `${Math.round(ms / 1000)} 秒` : `${(ms / 1000).toFixed(1)} 秒`
}

/** Live probe ladder: current phase on top, then one row per finished probe. */
export function ProbeLadder({ job, onLogs }: { job: Job; onLogs?(): void }) {
  return (
    <div className="wl-ladder" role="status" aria-label="验证进度">
      <p className="wl-ladder-phase">
        {job.status === 'running' || job.status === 'queued' ? (
          <>
            <CircleNotch size={15} className="wl-spin" />
            {job.status === 'queued' ? '等待执行' : '进行中…'}
          </>
        ) : (
          <>
            <StatusMark
              status={job.status === 'ok' ? 'pass' : job.status === 'fail' ? 'fail' : 'warn'}
            />
            {job.status === 'ok'
              ? '已完成'
              : job.status === 'fail'
                ? '验证未通过'
                : ['review', 'awaiting_auth', 'incomplete'].includes(job.status)
                  ? statusText(job.status)
                  : '任务异常结束'}
          </>
        )}
      </p>
      {['running', 'queued'].includes(job.status) && (
        <p className="wl-current-action">
          {job.phase ||
            (job.status === 'queued'
              ? '等待同一环境的前一个任务完成。'
              : job.probes.some((p) => p.check.startsWith('plugin-'))
                ? '依赖步骤已结束，正在准备配置检查和实验启动。'
                : '正在准备隔离环境和验证工具。')}
        </p>
      )}
      {!!job.probes.length && (
        <ul>
          {job.probes.map((probe, index) => (
            <li key={`${probe.check}-${index}`}>
              <StatusMark status={probe.status} />
              <span>
                {(
                  {
                    'plugin-add': '安装插件到实验环境',
                    'plugin-update': '升级实验中的插件',
                    'plugin-remove': '从实验移除插件',
                    compose: '检查配置与依赖组合',
                    'client-ready': '检查浏览器页面启动',
                    'core-ui': '检查核心界面',
                  } as Record<string, string>
                )[probe.check] ?? probe.label}
                {probe.required ? '' : <span className="wl-muted">（可选）</span>}
              </span>
              <time>{duration(probe)}</time>
              {probe.status === 'fail' && onLogs && (
                <button className="wl-button" onClick={onLogs}>
                  查看本次验证日志
                </button>
              )}
              {probe.status !== 'pass' && probe.status !== 'skip' && probe.detail && (
                <p className={probe.status === 'fail' ? 'wl-error' : 'wl-muted'}>{probe.detail}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Receipt facts of a terminal ok job (promote receipt, or restore/lab-add result highlights). */
export function JobReceipt({ job }: { job: Job }) {
  if (job.kind === 'version-matrix' && (job.result as any)?.rows)
    return <CompatibilityMatrix rows={(job.result as any).rows} />
  if (job.status !== 'ok') return null
  if (
    [
      'deployment-stage',
      'investigate',
      'environment-import',
      'version-matrix',
      'upgrade-check',
    ].includes(job.kind)
  )
    return (
      <div className="wl-event-detail">
        <p>任务已结算，请回到排障与交付面板查看逐项结果。</p>
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>
          {JSON.stringify(job.result, null, 2)}
        </pre>
      </div>
    )
  if (job.kind === 'lab-verify') return <p className="wl-muted">实验验证通过，尚未合入来源环境。</p>
  const result = (job.result ?? {}) as LabActionResult &
    Partial<LabPromoteCommandResult & RestoreCommandResult>
  const receipt = ['lab-add', 'lab-update', 'lab-remove', 'lab-config-apply'].includes(job.kind)
    ? result.promote
    : job.kind === 'restore'
      ? result.promoted
        ? result
        : undefined
      : result
  if (!receipt) return null
  const rows: [string, string][] = [
    ['提升前快照', receipt.preSnapshot],
    ['提升后快照', receipt.afterSnapshot ?? ''],
    ['Journal', 'journalId' in receipt ? (receipt.journalId ?? '') : ''],
    ['稳定世界线', 'lastKnownGood' in receipt ? (receipt.lastKnownGood ?? '') : ''],
  ].filter((row): row is [string, string] => !!row[1])
  return (
    <div className="wl-event-detail">
      <span className="wl-eyebrow">RECEIPT</span>
      <h3>已合入来源环境</h3>
      {rows.map(([name, value]) => (
        <p key={name}>
          {name}：<span className="wl-muted">{value}</span>
        </p>
      ))}
      <p className="wl-muted">
        {receipt.restartVerified
          ? '重启验证通过，已记录为稳定世界线。'
          : (receipt.restartPendingReason ?? '未进行重启验证。')}
      </p>
    </div>
  )
}

/**
 * Poll the `job` action every ~1.5s while the job runs. Stops on unmount or
 * terminal status; a lost job (host restarted) reports `gone` and settles with
 * null — 结果以世界线状态为准.
 */
export function useJob(
  api: (body: unknown, signal?: AbortSignal) => Promise<unknown>,
  jobId: string | null,
  onSettled?: (job: Job | null) => void,
) {
  const feed = useJobFeed()
  const notified = useRef<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [gone, setGone] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const settled = useRef(onSettled)
  settled.current = onSettled
  useEffect(() => {
    const update = feed.find((item) => item.id === jobId)
    if (!update) return
    setJob(update)
    setGone(false)
    setConnectionError('')
    if (!['running', 'queued'].includes(update.status) && notified.current !== update.id) {
      notified.current = update.id
      settled.current?.(update)
    }
  }, [feed, jobId])
  useEffect(() => {
    setJob(null)
    setGone(false)
    setConnectionError('')
    if (!jobId) return
    let active = true
    let timer = 0
    let first = true
    const poll = async () => {
      if (!first && jobsConnected()) {
        timer = window.setTimeout(() => void poll(), 10000)
        return
      }
      first = false
      try {
        const snapshot = (await api({ action: 'job', id: jobId })) as Job
        if (!active) return
        setConnectionError('')
        setJob(snapshot)
        if (!['running', 'queued'].includes(snapshot.status)) {
          if (notified.current !== snapshot.id) {
            notified.current = snapshot.id
            settled.current?.(snapshot)
          }
          return
        }
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : '连接暂时中断'
        if (message.includes('任务不存在')) {
          setGone(true)
          settled.current?.(null)
          return
        }
        setConnectionError(`${message} 正在重新连接，任务仍在后台运行。`)
      }
      timer = window.setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, jobId])
  return { job, gone, connectionError }
}
