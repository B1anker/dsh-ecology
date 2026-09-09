import { useEffect, useState } from 'react'
import type { ReportResult } from '../commands/report.js'
import type { ProbeResult } from '../domain/probe.js'
import { StatusMark, statusText } from './job-view.js'
import { ReportView } from './report-view.js'

export function VerificationRecord({
  id,
  api,
  expanded = false,
}: {
  id: string
  expanded?: boolean
  api(body: unknown, signal?: AbortSignal): Promise<ReportResult>
}) {
  const [open, setOpen] = useState(expanded)
  const [report, setReport] = useState<ReportResult | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!open || report) return
    const controller = new AbortController()
    setError('')
    const timeout = setTimeout(() => {
      controller.abort()
      setError('读取超时，请重试')
    }, 15000)
    void api({ action: 'report', id }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setReport(value)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '读取失败')
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [api, id, open, report, revision])
  const probes = (report?.sections.find((section) => section.title === 'probes')?.facts ??
    []) as ProbeResult[]
  return (
    <div className="wl-verification-record">
      {!expanded && (
        <button
          type="button"
          className="wl-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起验证记录' : '查看验证记录'}
        </button>
      )}
      {open && (
        <div>
          {!report && !error && <p role="status">正在读取验证记录…</p>}
          {error && (
            <div role="alert">
              <p className="wl-error">{error}</p>
              <button className="wl-button" onClick={() => setRevision((value) => value + 1)}>
                重试
              </button>
            </div>
          )}
          {report && (
            <>
              {Array.isArray(probes) &&
                probes.map((probe, index) => (
                  <div className="wl-verification-check" key={`${probe.check}-${index}`}>
                    <StatusMark status={probe.status} />
                    <div>
                      <strong>
                        {probe.label || probe.check} · {statusText(probe.status)}
                      </strong>
                      {probe.detail && <p>{probe.detail}</p>}
                    </div>
                  </div>
                ))}
              <details>
                <summary>完整日志与报告</summary>
                <ReportView report={report} />
              </details>
            </>
          )}
        </div>
      )}
    </div>
  )
}
