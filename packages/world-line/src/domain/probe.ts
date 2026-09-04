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
  summary.ok = summary.failed === 0 && summary.inconclusive === 0
  return summary
}
