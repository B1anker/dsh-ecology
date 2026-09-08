import { useEffect, useState } from 'react'
export interface LabStatus {
  sourceId: string
  sourceName: string
  id: string
  name: string
  profileName: string
  clientGate: 'pass' | 'fail' | 'inconclusive'
  canPromote: boolean
  createdAt: string
}
export function useLabStatus(
  api: (body: unknown, signal?: AbortSignal) => Promise<any>,
  id: string | null,
  revision: string,
) {
  const [status, setStatus] = useState<LabStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setStatus(null)
    setError('')
    if (!id) return
    const controller = new AbortController()
    void api({ action: 'lab-status', id }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('暂时无法确认实验状态，请刷新；若服务仍运行旧版本，请重启 DSH 后再试。')
      })
    return () => controller.abort()
  }, [api, id, revision])
  return { status, error }
}
