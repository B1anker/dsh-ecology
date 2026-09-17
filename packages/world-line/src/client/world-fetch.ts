/**
 * The one reader of `GET /api/world-line` for the whole page.
 *
 * Two surfaces poll the world on their own clocks: the canvas every 10 s
 * while it is open, the corner entry every 15 s for its "current world"
 * label. Both used to run the fetch themselves against one shared cache,
 * each capturing the cache as its baseline, asking for the delta since that
 * baseline's revision, and refusing to apply the answer if the cache had
 * moved meanwhile. Whenever the two clocks overlapped, whichever answer
 * landed second was thrown away as "更新已过期", and the canvas showed a load
 * error — or the entry a "暂不可用" tooltip — for a request that had in fact
 * succeeded.
 *
 * Here the fetch is single-flight: a caller that arrives while one is in the
 * air awaits that same request. Only this module writes the cache, one
 * request at a time, so a baseline can no longer go stale under a request.
 * Callers still get their own abort: dropping a caller's signal detaches it
 * from the shared promise without cancelling the request the other caller
 * is waiting on.
 *
 * @module client/world-fetch
 */

import { mergeWorldResponse } from './world-data.js'

/** Reject `promise` early when `signal` aborts; the promise itself runs on. */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const abortError = () =>
      (signal.reason as unknown) ?? new DOMException('The operation was aborted.', 'AbortError')
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export interface WorldReader {
  /** The merged world, fetched as a delta against the cached revision. */
  read(signal?: AbortSignal): Promise<any>
  /** The last merged world, or null before the first successful read. */
  current(): any
}

/**
 * Build a reader over `fetchImpl` (the page's `fetch` in production). One
 * instance per page; the module-level {@link worldReader} is that instance.
 */
export function createWorldReader(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): WorldReader {
  let last: any = null
  let inflight: Promise<any> | null = null

  const run = async (): Promise<any> => {
    const base = last
    const response = await fetchImpl(
      base?.revision
        ? `/api/world-line?since=${encodeURIComponent(base.revision)}`
        : '/api/world-line',
      { cache: 'no-store' },
    )
    if (response.status === 401 || response.status === 403)
      throw new Error('登录已失效，请返回 DSH 重新登录后再试。')
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('未收到管理服务响应，请检查连接或重新登录。')
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`)
    // Single-flight makes this unreachable; it stays as the invariant it is.
    if (last !== base) throw new Error('更新已过期，保留当前画布')
    last = mergeWorldResponse(base, data, base?.revision)
    return last
  }

  return {
    read(signal) {
      if (inflight === null) {
        inflight = run().finally(() => {
          inflight = null
        })
      }
      return untilAborted(inflight, signal)
    },
    current: () => last,
  }
}

/** The page's reader; every surface polls through it. */
export const worldReader = createWorldReader()
