import { useEffect, useRef, useState } from 'react'
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
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 24,
        zIndex: 80,
        padding: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid #edbb16',
      }}
    >
      <button
        onClick={() => {
          setCount(0)
          onOpen()
        }}
      >
        {count} 个世界线任务已结束，查看任务
      </button>
    </div>
  ) : null
}
