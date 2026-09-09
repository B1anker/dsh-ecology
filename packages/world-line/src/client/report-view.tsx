import { useEffect, useId, useState } from 'react'
import type { ReportResult } from '../commands/report.js'
export function ReportView({ report }: { report: ReportResult }) {
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState<any>(null)
  const [tab, setTab] = useState(0)
  const tabId = useId()
  useEffect(() => {
    setTab(0)
  }, [report.reportId])
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview)
    },
    [preview],
  )
  const api = async (body: object) => {
    const r = await fetch('/api/world-line', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error)
    return data
  }
  const artifactUrl = (id: string, name: string) =>
    `/api/world-line?lab=${encodeURIComponent(report.target.id)}&artifact=${encodeURIComponent(id)}&file=${encodeURIComponent(name)}`

  const text = JSON.stringify(report, null, 2)
  const names: Record<string, string> = {
    'lab manifest': '实验信息',
    probes: '检查结果',
    'private browser artifacts': '截图与附件',
    'snapshot manifest': '快照信息',
    'profile files present': '配置文件',
    浏览器证据与覆盖范围: '浏览器检查',
  }
  return (
    <div className="wl-flow-actions">
      <p>
        {report.reportId} · {new Date(report.createdAt).toLocaleString()}
      </p>
      <div className="wl-flow-actions-row">
        <button
          className="wl-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setNotice('已复制脱敏报告')
            } catch {
              setNotice('复制失败，请下载报告')
            }
          }}
        >
          复制报告
        </button>
        <button
          className="wl-button"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
            const a = document.createElement('a')
            a.href = url
            a.download = `${report.reportId}.json`
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          }}
        >
          下载 JSON
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {report.notes.map((note, i) => (
        <p className="wl-muted" key={i}>
          {note}
        </p>
      ))}
      <div className="wl-report-tabs" role="tablist" aria-label="日志与报告分类">
        {report.sections.map((section, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`${tabId}-tab-${i}`}
            aria-controls={`${tabId}-panel-${i}`}
            aria-selected={tab === i}
            tabIndex={tab === i ? 0 : -1}
            onClick={() => setTab(i)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (i + 1) % report.sections.length
                  : event.key === 'ArrowLeft'
                    ? (i - 1 + report.sections.length) % report.sections.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? report.sections.length - 1
                        : null
              if (next === null) return
              event.preventDefault()
              setTab(next)
              document.getElementById(`${tabId}-tab-${next}`)?.focus()
            }}
          >
            {names[section.title] ?? section.title.replace('log tail: ', '日志 · ')}
          </button>
        ))}
      </div>
      {report.sections.map((section, i) =>
        section.title === 'private browser artifacts' ? null : (
          <section
            key={i}
            hidden={tab !== i}
            role="tabpanel"
            tabIndex={0}
            id={`${tabId}-panel-${i}`}
            aria-labelledby={`${tabId}-tab-${i}`}
            className="wl-report-content"
          >
            {section.title !== 'private browser artifacts' && (
              <pre>{section.text ?? JSON.stringify(section.facts, null, 2)}</pre>
            )}
          </section>
        ),
      )}
      {report.sections[tab]?.title === 'private browser artifacts' &&
        report.target.kind === 'lab' &&
        report.sections.some((s) => s.title === 'private browser artifacts') && (
          <section
            className="wl-event-detail wl-report-content"
            role="tabpanel"
            tabIndex={0}
            id={`${tabId}-panel-${tab}`}
            aria-labelledby={`${tabId}-tab-${tab}`}
          >
            <p>
              以下原始截图和 trace
              未脱敏，可能包含凭据、页面文字和网络数据。只有主动打开或下载才会读取。
            </p>
            {report.sections
              .filter((s) => s.title === 'private browser artifacts')
              .flatMap((s) => (Array.isArray(s.facts) ? s.facts : []))
              .map((row: any) => (
                <div key={row.id}>
                  <p>
                    {row.createdAt} · {row.environment}
                  </p>
                  {row.files.map((file: any) => (
                    <button
                      className="wl-button"
                      key={file.name}
                      onClick={async () => {
                        try {
                          const r = await fetch(artifactUrl(row.id, file.name))
                          if (!r.ok) throw new Error('工件无法读取')
                          const url = URL.createObjectURL(await r.blob())
                          if (file.name === 'failure.png') setPreview(url)
                          else {
                            const a = document.createElement('a')
                            a.href = url
                            a.download = `${row.id}-trace.zip`
                            a.click()
                            setTimeout(() => URL.revokeObjectURL(url), 1000)
                          }
                        } catch (e) {
                          setNotice(String(e))
                        }
                      }}
                    >
                      {file.name === 'failure.png' ? '查看原始截图' : '下载原始 trace'}
                    </button>
                  ))}
                </div>
              ))}
            {preview && (
              <>
                <img src={preview} alt="验证失败时的原始页面截图" style={{ maxWidth: '100%' }} />
                <button className="wl-button" onClick={() => setPreview(null)}>
                  关闭截图
                </button>
              </>
            )}
            <button
              className="wl-button"
              onClick={() =>
                void api({ action: 'artifact-cleanup-preview', id: report.target.id })
                  .then(setCleanup)
                  .catch((e) => setNotice(e.message))
              }
            >
              预览历史工件清理
            </button>
            {cleanup && (
              <div>
                <p>
                  将清理 {cleanup.candidates.length} 组工件，共 {cleanup.bytes}{' '}
                  字节。保留最新一组，其余最多 30 组或 7 天。
                </p>
                <button
                  className="wl-button"
                  onClick={() =>
                    void api({
                      action: 'artifact-cleanup-apply',
                      id: report.target.id,
                      revision: cleanup.revision,
                      requestId: crypto.randomUUID(),
                    })
                      .then(() => {
                        setCleanup(null)
                        setNotice('历史工件已清理，请刷新报告')
                      })
                      .catch((e) => setNotice(e.message))
                  }
                >
                  确认清理
                </button>
              </div>
            )}
          </section>
        )}
    </div>
  )
}
