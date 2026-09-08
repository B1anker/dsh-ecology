/**
 * Probe results (WORLD-LINE-SPEC §6 "通过标准"): every validation step of a
 * lab run records one ProbeResult — check id, human label, whether it is
 * required, its wall-clock window, a redacted detail, and the entry/plugin
 * ids it names. `summarizeProbes` turns a list into the pass/fail verdict a
 * lab run reports (ok ⇔ no failures and no inconclusive results).
 */

/** One recorded validation step of a lab run. */
export type ProbeStatus = 'pass' | 'fail' | 'inconclusive' | 'warn' | 'skip'

export interface ProbeResult {
  check: string
  label: string
  required: boolean
  startedAt: string
  finishedAt: string
  status: ProbeStatus
  /** Redacted human detail. */
  detail?: string
  /** Entry/plugin ids this probe names (duplicates, cycles, candidates). */
  entries?: string[]
}

export const COMPOSE_CHECK = 'compose'
export const HOST_BOOT_CHECK = 'host-boot'
export const HTTP_READY_CHECK = 'http-ready'

/** Record one finished probe. */
export function probe(
  now: Date,
  check: string,
  label: string,
  status: ProbeStatus,
  options?: { required?: boolean; detail?: string; entries?: string[] },
): ProbeResult {
  const required = options?.required ?? !(status === 'warn' || status === 'skip')
  return {
    check,
    label,
    required,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    status,
    ...(options?.detail !== undefined ? { detail: options.detail } : {}),
    ...(options?.entries !== undefined && options.entries.length > 0
      ? { entries: options.entries }
      : {}),
  }
}

export interface ProbeSummary {
  total: number
  passed: number
  failed: number
  warned: number
  skipped: number
  inconclusive: number
  /** Verdict: no failures and no inconclusive results. */
  ok: boolean
}

/** Summarize one run's probes; warn/skip never fail a run. */
export function summarizeProbes(results: readonly ProbeResult[]): ProbeSummary {
  const summary: ProbeSummary = {
    total: results.length,
    passed: 0,
    failed: 0,
    warned: 0,
    skipped: 0,
    inconclusive: 0,
    ok: true,
  }
  for (const result of results) {
    switch (result.status) {
      case 'pass':
        summary.passed += 1
        break
      case 'fail':
        summary.failed += 1
        break
      case 'warn':
        summary.warned += 1
        break
      case 'skip':
        summary.skipped += 1
        break
      case 'inconclusive':
        summary.inconclusive += 1
        break
    }
  }
  summary.ok = results.every((result) => !result.required || result.status === 'pass')
  return summary
}

/** v2 execution result; legacy records retain their recorded interpretation. */
export function verificationState(
  probes: readonly ProbeResult[],
): 'passed' | 'failed' | 'awaiting_auth' | 'review' | 'incomplete' | undefined {
  if (!probes.some((p) => p.check === 'plugin-function')) return undefined
  if (probes.some((p) => p.required && p.status === 'fail')) return 'failed'
  if (
    probes.some(
      (p) =>
        p.check === 'browser-boot' && p.status === 'inconclusive' && /登录/.test(p.detail ?? ''),
    )
  )
    return 'awaiting_auth'
  if (probes.some((p) => p.check === 'client-observations' && p.status === 'inconclusive'))
    return 'review'
  return summarizeProbes(probes).ok ? 'passed' : 'incomplete'
}
