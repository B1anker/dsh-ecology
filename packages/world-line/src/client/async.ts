import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiFn } from './api-types.js'

export function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error ? e.message : fallback
}

/**
 * 统一的「异步加载 + 防过期写入」hook，覆盖现有 AbortController / 布尔标志 / 版本计数三套手写范式。
 * - request 为 null 时跳过加载并复位状态（条件加载，如维护面板非诊断页签）；
 * - request 为函数时以 signal 调用（组合多次请求的场景，需用 useCallback 固定引用），
 *   否则作为 body 交给 api 并把 signal 传下去；
 * - AbortController 中断 + 版本号双重兜底，过期回调不写状态。
 */
export function useApiQuery<T>(
  api: ApiFn,
  request: unknown | ((signal: AbortSignal) => Promise<T>) | null,
  deps: readonly unknown[],
  options: {
    fallback?: string
    /** true 时新一轮加载不清空已有数据（如重新诊断时保留上次结果，research 面板刷新）。 */
    keepData?: boolean
    /** 写入 data 前调用；抛错会转为 error（用于结果校验、派生状态，如合入预览的目标确认）。 */
    onSuccess?: (data: T) => void
  } = {},
) {
  const { fallback = '读取失败', keepData = false, onSuccess } = options
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const loadVersion = useRef(0)
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    const version = ++loadVersion.current
    const active = () => !controller.signal.aborted && loadVersion.current === version
    const stop = () => {
      loadVersion.current += 1
      controller.abort()
    }
    setError('')
    if (request === null || request === undefined) {
      if (!keepData) setData(null)
      setLoading(false)
      return stop
    }
    if (!keepData) setData(null)
    setLoading(true)
    const pending =
      typeof request === 'function' ? request(controller.signal) : api(request, controller.signal)
    void Promise.resolve(pending)
      .then((value: T) => {
        if (!active()) return
        try {
          onSuccessRef.current?.(value)
        } catch (e) {
          setError(errorMessage(e, fallback))
          return undefined
        }
        setData(value)
        return undefined
      })
      .catch((e) => {
        if (active()) setError(errorMessage(e, fallback))
      })
      .finally(() => {
        if (active()) setLoading(false)
      })
    return stop
  }, [api, revision, keepData, fallback, ...deps])
  return { data, error, loading, reload }
}

/** 统一的「busy + error + try/catch/finally」动作执行器；附加守卫与附带逻辑留在调用方。 */
export function useActionRunner() {
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const busy = useRef(false)
  const run = useCallback(
    async <T>(
      pendingText: string,
      task: () => Promise<T>,
      onSuccess: (result: T) => void,
      fallback: string,
    ): Promise<void> => {
      if (busy.current) return
      busy.current = true
      setPending(pendingText)
      setError('')
      try {
        onSuccess(await task())
      } catch (e) {
        setError(errorMessage(e, fallback))
      } finally {
        busy.current = false
        setPending('')
      }
    },
    [],
  )
  return { pending, error, setError, run }
}
