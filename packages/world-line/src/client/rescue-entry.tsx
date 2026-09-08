import { useRef, useState } from 'react'
import { useWorldLineEntry } from './entry.js'

/** Keep the manager open, with the same popup and blocked-popup fallback as mirror entry. */
export function RescueEntryButton({
  api,
  id,
  disabled = false,
}: {
  api(body: unknown): Promise<{ url: string }>
  id: string
  disabled?: boolean
}) {
  const source = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const { begin, entry } = useWorldLineEntry()
  const enter = async () => {
    if (busy || !source.current) return
    setBusy(true)
    const transition = begin(`救援 ${id.slice(-8)}`, id, source.current)
    try {
      const result = await api({ action: 'rescue-enter', id })
      if (!result.url) throw new Error('救援实例未返回进入地址，请重新启动救援。')
      await transition.finish(result.url)
    } catch (error) {
      transition.fail(error instanceof Error ? error.message : '进入救援失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {entry}
      <button
        ref={source}
        className="wl-button"
        disabled={disabled || busy}
        onClick={() => void enter()}
      >
        {busy ? '正在进入…' : '进入救援实例'}
      </button>
    </>
  )
}
