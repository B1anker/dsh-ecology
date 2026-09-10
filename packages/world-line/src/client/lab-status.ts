import { useCallback } from 'react'
import type { ApiFn } from './api-types.js'
import { useApiQuery } from './async.js'

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
const ERROR_TEXT = '暂时无法确认实验状态，请刷新；若服务仍运行旧版本，请重启 DSH 后再试。'
export function useLabStatus(api: ApiFn, id: string | null, revision: string) {
  // 原实现忽略底层错误、统一展示固定文案：抛出非 Error 使 errorMessage 落到 fallback。
  const request = useCallback(
    (signal: AbortSignal) =>
      api({ action: 'lab-status', id }, signal).catch(() => {
        throw ERROR_TEXT
      }),
    [api, id],
  )
  const { data: status, error } = useApiQuery<LabStatus>(api, id ? request : null, [id, revision], {
    fallback: ERROR_TEXT,
  })
  return { status, error }
}
