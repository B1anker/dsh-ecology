/** Durable manager-scoped jobs. Execution is never replayed after a process dies. */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { LockedError, UsageError } from '../domain/errors.js'
import type { ProbeResult } from '../domain/probe.js'
import { verificationState } from '../domain/probe.js'
import { redactData } from '../domain/redact-data.js'
import { redactText } from '../domain/redaction.js'
import { isProcessAlive } from '../fs/lock.js'
import { withOperations } from '../fs/operation.js'
import { labHomeDir } from '../lab/layout.js'
import { TRANSACTION_ID_RE, transactionDir } from '../lab/transaction.js'
export type JobKind =
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
export type JobStatus =
  | 'queued'
  | 'running'
  | 'ok'
  | 'fail'
  | 'review'
  | 'awaiting_auth'
  | 'incomplete'
  | 'error'
  | 'interrupted'
export interface JobScope {
  home: string
  profileName: string
  resource: string
}
export interface Job {
  id: string
  kind: JobKind
  labId?: string
  transactionId?: string
  status: JobStatus
  phase: string
  probes: ProbeResult[]
  result?: unknown
  error?: string
  startedAt: string
  finishedAt?: string
  schemaVersion?: 1
  revision?: number
  profileName?: string
  resource?: string
  ownerPid?: number
  ownerHost?: string
}
export interface JobHandle {
  readonly id: string
  readonly kind: JobKind
  setPhase(phase: string): void
  pushProbe(probe: ProbeResult): void
  setLabId(id: string): void
  setTransactionId(id: string): void
}
export type JobRunner = (job: JobHandle) => Promise<unknown>
/** Runner option callbacks bound to the job handle. */
export interface JobHooks {
  onProbe(probe: ProbeResult): void
  onPhase(phase: string): void
  onLabCreated(id: string): void
  onTransaction(id: string): void
}
const jobs = new Map<string, Job>()
const scopes = new Map<string, JobScope>()
const pending = new Map<string, JobRunner>()
const listeners = new Set<() => void>()
export function subscribeJobs(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function file(scope: JobScope, id: string) {
  return join(scope.home, 'world-line', 'jobs', `${id}.json`)
}
function persist(job: Job) {
  const scope = scopes.get(job.id)
  job.revision = (job.revision ?? 0) + 1
  if (scope) {
    const dir = join(scope.home, 'world-line', 'jobs')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = file(scope, job.id)
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(redactData(job)), { mode: 0o600 })
    const handle = openSync(temp, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temp, path)
    if (process.platform !== 'win32') {
      const directory = openSync(dir, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* A disconnected subscriber cannot fail the operation. */
    }
  }
}
function key(job: Job) {
  const s = scopes.get(job.id)
  return s ? `${s.home}\0${s.profileName}\0${s.resource}` : 'legacy'
}
function prune() {
  for (const [id, job] of jobs)
    if (job.finishedAt && Date.now() - Date.parse(job.finishedAt) > 30 * 86400000) {
      const scope = scopes.get(id)
      if (scope) rmSync(file(scope, id), { force: true })
      jobs.delete(id)
      scopes.delete(id)
    }
  const legacy = [...jobs.values()]
    .filter((j) => !scopes.has(j.id) && j.finishedAt)
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
  for (const job of legacy.slice(0, Math.max(0, legacy.length - 20))) jobs.delete(job.id)
}
function dispatch() {
  for (const [id, runner] of pending) {
    const job = jobs.get(id)!
    if (
      [...jobs.values()].some(
        (other) => other.id !== id && other.status === 'running' && key(other) === key(job),
      )
    )
      continue
    pending.delete(id)
    job.status = 'running'
    persist(job)
    const handle: JobHandle = {
      id,
      kind: job.kind,
      setPhase: (phase) => {
        job.phase = redactText(phase)
        persist(job)
      },
      pushProbe: (probe) => {
        job.probes.push(redactData(probe))
        persist(job)
      },
      setTransactionId: (transactionId) => {
        job.transactionId = transactionId
        persist(job)
      },
      setLabId: (labId) => {
        job.labId = labId
        persist(job)
      },
    }
    void (async () => {
      let entered = false,
        retry = false
      try {
        const scope = scopes.get(id)
        const execute = async () => {
          entered = true
          return runner(handle)
        }
        const result = scope
          ? await withOperations(
              [scope.resource === 'origin' ? scope.home : labHomeDir(scope.home, scope.resource)],
              scope.profileName,
              execute,
            )
          : await execute()
        job.result = redactData(result ?? null)
        const verdict = verificationState(job.probes)
        job.status =
          typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false
            ? verdict === 'passed' || verdict === undefined || verdict === 'failed'
              ? 'fail'
              : verdict
            : 'ok'
      } catch (e) {
        if (e instanceof LockedError && !entered && !e.message.includes('stale')) {
          retry = true
          job.status = 'queued'
          job.phase = '等待其他 CLI 或窗口释放此来源'
          pending.set(id, runner)
        } else {
          job.status = 'error'
          job.error = redactText(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (retry) {
          try {
            persist(job)
            const timer = setTimeout(dispatch, 2000)
            timer.unref()
          } catch {
            pending.delete(id)
            job.status = 'error'
            job.error = '排队记录保存失败，请检查存储后重新提交'
          }
        } else {
          job.finishedAt = new Date().toISOString()
          try {
            persist(job)
          } catch {
            job.status = 'error'
            job.error = '任务结束，但记录保存失败；请查看实验与诊断报告确认结果'
          } finally {
            prune()
            dispatch()
          }
        }
      }
    })()
  }
}
export function startJob(kind: JobKind, runner: JobRunner, labId?: string, scope?: JobScope): Job {
  if (!scope && [...jobs.values()].some((j) => j.status === 'running'))
    throw new UsageError('已有验证任务进行中')
  const job: Job = {
    id: `job-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    schemaVersion: 1,
    kind,
    labId,
    status: 'queued',
    phase: '',
    probes: [],
    startedAt: new Date().toISOString(),
    profileName: scope?.profileName,
    resource: scope?.resource,
    ownerPid: process.pid,
    ownerHost: hostname(),
  }
  if (scope) scopes.set(job.id, scope)
  persist(job)
  jobs.set(job.id, job)
  pending.set(job.id, runner)
  dispatch()
  return job
}
/** startJob with the caller's home/profile scope and the standard handle wiring pre-bound. */
export function startScopedJob(
  scope: Pick<JobScope, 'home' | 'profileName'>,
  resource: string,
  kind: JobKind,
  run: (handle: JobHandle, hooks: JobHooks) => Promise<unknown>,
  labId?: string,
): Job {
  return startJob(
    kind,
    (handle) =>
      run(handle, {
        onProbe: (probe) => handle.pushProbe(probe),
        onPhase: (phase) => handle.setPhase(phase),
        onLabCreated: (id) => handle.setLabId(id),
        onTransaction: (id) => handle.setTransactionId(id),
      }),
    labId,
    { home: scope.home, profileName: scope.profileName, resource },
  )
}
export function getJob(
  id: string,
  scope?: Pick<JobScope, 'home' | 'profileName'>,
): Job | undefined {
  if (!/^job-[a-z0-9-]+$/.test(id)) return undefined
  if (scope) {
    const known = scopes.get(id)
    if (known && (known.home !== scope.home || known.profileName !== scope.profileName))
      return undefined
    try {
      const disk = JSON.parse(readFileSync(file({ ...scope, resource: '' }, id), 'utf8')) as Job
      if (disk.schemaVersion !== 1 || disk.id !== id || disk.profileName !== scope.profileName)
        return undefined
      if (
        !jobs.has(id) ||
        disk.ownerPid !== process.pid ||
        (disk.transactionId && ['interrupted', 'error'].includes(disk.status))
      ) {
        if (
          (disk.status === 'running' || disk.status === 'queued') &&
          disk.ownerHost === hostname() &&
          disk.ownerPid &&
          !isProcessAlive(disk.ownerPid)
        ) {
          disk.status = 'interrupted'
          disk.phase = '宿主已重启，请检查实验状态后重验'
          disk.finishedAt = new Date().toISOString()
          scopes.set(id, { ...scope, resource: disk.resource ?? 'origin' })
          persist(disk)
        }
        if (
          ['interrupted', 'error'].includes(disk.status) &&
          disk.transactionId &&
          TRANSACTION_ID_RE.test(disk.transactionId)
        ) {
          try {
            const home =
              disk.resource && disk.resource !== 'origin'
                ? labHomeDir(scope.home, disk.resource)
                : scope.home
            const record = JSON.parse(
              readFileSync(join(transactionDir(home, disk.transactionId), 'record.json'), 'utf8'),
            )
            if (
              record.version === 1 &&
              record.id === disk.transactionId &&
              record.profileName === scope.profileName &&
              record.labId === disk.labId &&
              record.entry?.id === record.id &&
              (record.phase !== 'committed' ||
                (record.entry.outcome === 'committed' && record.result?.ok === true))
            ) {
              const priorPhase = disk.phase
              if (record.phase === 'committed') {
                disk.status = 'ok'
                disk.phase = '合入已提交，任务状态已从事务记录恢复'
                disk.result =
                  disk.kind === 'restore'
                    ? {
                        ...record.result,
                        labId: record.labId,
                        kind: 'promote',
                        snapshotId: record.entry.snapshotId,
                        promoted: true,
                      }
                    : disk.kind === 'promote'
                      ? { ...record.result, labId: record.labId, profileName: record.profileName }
                      : { ok: true, labId: record.labId, promote: record.result }
                delete disk.error
              } else if (record.phase === 'rolled-back') {
                disk.status = 'error'
                disk.phase = '合入未完成，受管文件已回滚；实例需要重新验证'
                disk.error = disk.phase
              } else {
                disk.phase = `合入事务中断于 ${record.phase}；请先恢复事务`
                disk.error = `recovery reconcile ${record.id} --yes（来源 home: ${home}）`
              }
              if (priorPhase !== disk.phase) {
                scopes.set(id, { ...scope, resource: disk.resource ?? 'origin' })
                if (jobs.has(id)) jobs.set(id, disk)
                persist(disk)
              }
            }
          } catch {
            /* Missing or corrupt evidence never upgrades an interrupted job to success. */
          }
        }
        return disk
      }
    } catch {
      return undefined
    }
  }
  const job = jobs.get(id)
  return job ? { ...job, probes: [...job.probes] } : undefined
}
export function listJobs(scope: Pick<JobScope, 'home' | 'profileName'>): Job[] {
  let names: string[] = []
  try {
    names = readdirSync(join(scope.home, 'world-line', 'jobs'))
  } catch {}
  const records = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => getJob(n.slice(0, -5), scope))
    .filter((j): j is Job => !!j)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  let kept = 0
  return records.filter((job) => {
    if (!job.finishedAt) return true
    kept++
    if (kept <= 1000 && Date.now() - Date.parse(job.finishedAt) < 30 * 86400000) return true
    try {
      rmSync(file({ ...scope, resource: job.resource ?? '' }, job.id), { force: true })
      jobs.delete(job.id)
      scopes.delete(job.id)
    } catch {}
    return false
  })
}
