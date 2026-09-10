import { useRef } from 'react'
import type { ApiFn } from './api-types.js'
import { errorMessage, useActionRunner } from './async.js'
import { useWorldLineEntry } from './entry.js'

/** Keep the manager open, with the same popup and blocked-popup fallback as mirror entry. */
export function RescueEntryButton({
  api,
  id,
  disabled = false,
}: {
  api: ApiFn
  id: string
  disabled?: boolean
}) {
  const source = useRef<HTMLButtonElement>(null)
  const { pending, run } = useActionRunner()
  const { begin, entry } = useWorldLineEntry()
  const enter = () => {
    if (pending || !source.current) return
    const transition = begin(`救援 ${id.slice(-8)}`, id, source.current)
    void run(
      '正在进入…',
      async () => {
        try {
          const result = await api({ action: 'rescue-enter', id })
          if (!result.url) throw new Error('救援实例未返回进入地址，请重新启动救援。')
          await transition.finish(result.url)
        } catch (error) {
          transition.fail(errorMessage(error, '进入救援失败'))
        }
      },
      () => {},
      '进入救援失败',
    )
  }
  return (
    <>
      {entry}
      <button ref={source} className="wl-button" disabled={disabled || !!pending} onClick={enter}>
        {pending ? '正在进入…' : '进入救援实例'}
      </button>
    </>
  )
}
