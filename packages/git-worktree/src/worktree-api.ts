import type { Branch, Services, Workspace, WorktreeConflict } from './client-contracts.js'

export function parseConflict(value: Record<string, unknown>): WorktreeConflict {
  return {
    targetPath: typeof value.targetPath === 'string' ? value.targetPath : '',
    directoryExists: value.directoryExists === true,
    branchExists: value.branchExists === true,
  }
}

export async function request(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '请求失败')
  return data
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
