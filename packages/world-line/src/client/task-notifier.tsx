import { ListChecks } from '@phosphor-icons/react/dist/csr/ListChecks'
import { useEffect, useRef, useState } from 'react'
import { CloseButton } from './close-button.js'
import type { Job } from './job-view.js'
export function TaskNotifier({ jobs, onOpen }: { jobs: Job[]; onOpen(): void }) {
  const seen = useRef(new Set<string>()),
    initialized = useRef(false)
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!jobs.length) return
    let added = 0
    for (const job of jobs) {
      if (['running', 'queued'].includes(job.status)) continue
      if (!seen.current.has(job.id)) {
        seen.current.add(job.id)
        if (initialized.current) {
          added++
          if (
            'Notification' in window &&
            Notification.permission === 'granted' &&
            localStorage.getItem('wl-task-notifications') === 'on'
          ) {
            try {
              const notification = new Notification('世界线任务已结束', {
                body:
                  job.status === 'ok'
                    ? '操作已完成，打开任务台查看结果'
                    : '任务需要检查，打开任务台查看诊断',
                tag: job.id,
              })
              notification.onclick = () => {
                window.focus()
                onOpen()
                notification.close()
              }
            } catch {}
          }
        }
      }
    }
    initialized.current = true
    if (added) setCount((n) => n + added)
  }, [jobs])
  useEffect(() => {
    if (!count) return
    const title = document.title
    document.title = `(${count} 个任务已完成) ${title}`
    return () => {
      document.title = title
    }
  }, [count])
  return count ? (
    <div className="wl-task-notice" role="status" aria-live="polite" aria-atomic="true">
      <span className="wl-task-notice-icon" aria-hidden="true">
        <ListChecks size={20} />
      </span>
      <div className="wl-task-notice-content">
        <span className="wl-task-notice-title">{count} 项任务已结束</span>
        <button
          type="button"
          className="wl-task-notice-open"
          onClick={() => {
            setCount(0)
            onOpen()
          }}
        >
          查看任务
        </button>
      </div>
      <CloseButton
        className="wl-task-notice-dismiss"
        aria-label="关闭任务通知"
        onClick={() => setCount(0)}
      />
    </div>
  ) : null
}
