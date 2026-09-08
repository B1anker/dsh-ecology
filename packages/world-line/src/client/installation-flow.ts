import type { Job } from './job-view.js'

/** Resume only this source's unfinished installation flow, using server-owned scope. */
export function installationToResume(jobs: Job[], sourceId: string): Job | null {
  const scoped = jobs
    .filter(
      (job) => job.resource === sourceId && ['lab-add', 'lab-verify', 'promote'].includes(job.kind),
    )
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
  const active = scoped.find((job) => ['queued', 'running'].includes(job.status))
  if (active) return active
  const latest = scoped[0]
  if (!latest) return null
  if (['review', 'awaiting_auth', 'incomplete'].includes(latest.status)) return latest
  const result = latest.result as { promote?: unknown; promoted?: boolean } | undefined
  if (latest.status === 'ok' && latest.kind !== 'promote' && !result?.promote && !result?.promoted)
    return latest // Verification has finished; the user's merge decision has not.
  return null
}
