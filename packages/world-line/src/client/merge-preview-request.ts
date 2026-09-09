import type { MergePreview } from '../domain/merge-types.js'

/** A queued or disconnected request must not leave the picker loading forever. */
export async function requestMergePreview(
  api: (body: unknown, signal?: AbortSignal) => Promise<MergePreview>,
  id: string,
  targetId: string,
  signal: AbortSignal,
  timeoutMs = 15000,
): Promise<MergePreview> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort()
      reject(new DOMException('Preview cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    timer = setTimeout(() => {
      reject(new Error('比较超时，请检查连接后重试。'))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      interrupted,
      api({ action: 'merge-preview', id, targetId }, controller.signal),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
