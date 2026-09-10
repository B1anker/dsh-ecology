import { useCallback, useState } from 'react'
import type { ReportResult } from '../commands/report.js'
import type { ProbeResult } from '../domain/probe.js'
import type { ApiFn } from './api-types.js'
import { useApiQuery } from './async.js'
import { StatusMark, statusText } from './job-view.js'
import { ReportView } from './report-view.js'

export function VerificationRecord({
  id,
  api,
  expanded = false,
}: {
  id: string
  expanded?: boolean
  api: ApiFn
}) {
  const [open, setOpen] = useState(expanded)
  const [report, setReport] = useState<ReportResult | null>(null)
  // 15 秒超时属于本组件附加逻辑，保留在调用方：超时以固定文案 reject，接口错误原样上抛。
  const request = useCallback(
    (signal: AbortSignal) =>
      new Promise<ReportResult>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('读取超时，请重试')), 15000)
        api({ action: 'report', id }, signal).then(
          (value: ReportResult) => {
            clearTimeout(timeout)
            resolve(value)
          },
          (e: unknown) => {
            clearTimeout(timeout)
            reject(e)
          },
        )
      }),
    [api, id],
  )
  const { error, reload } = useApiQuery<ReportResult>(
    api,
    open && !report ? request : null,
    [id, open, report],
    { fallback: '读取失败', onSuccess: setReport },
  )
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
              <button className="wl-button" onClick={reload}>
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
