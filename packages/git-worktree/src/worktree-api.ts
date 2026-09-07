import type { Branch, Services, Workspace, WorktreeConflict } from './client-contracts.js'

export function parseConflict(value: Record<string, unknown>): WorktreeConflict {
  return {
    targetPath: typeof value.targetPath === 'string' ? value.targetPath : '',
    directoryExists: value.directoryExists === true,
    branchExists: value.branchExists === true,
  }
}

const DEFAULT_TIMEOUT_MS = 4_000

export async function request(
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options?.signal?.aborted) controller.abort()
  else options?.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '请求失败')
    return data
  } finally {
    window.clearTimeout(timer)
    options?.signal?.removeEventListener('abort', onAbort)
  }
}

export function currentWorkspace(services: Services): Workspace | undefined {
  const items = services.workspaces?.list.getSnapshot().items ?? []
  const current = services.sessions?.list.getSnapshot().current
  return (
    items.find((item) => current !== undefined && item.sessionIds?.includes(current)) ??
    items.at(-1)
  )
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Show a Toast hosted by the React worktree control (not window.alert). */
export function showWorktreeToast(text: string): void {
  window.dispatchEvent(new CustomEvent('dsh-git-worktree:toast', { detail: { text } }))
}

function branchRank(branch: Branch): number {
  const name = branch.name.toLowerCase()
  if (name === 'main') return 0
  if (name === 'master') return 1
  if (branch.current === true) return 2
  return 3
}

export function branchOrder(left: Branch, right: Branch): number {
  return branchRank(left) - branchRank(right) || left.name.localeCompare(right.name)
}
