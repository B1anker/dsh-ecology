/** One entry of the `lines` array returned by the world-lines listing. */
export interface WorldLineInfo {
  id: string
  alias?: string
  initialization?: 'clean'
  completedAt?: string
  parentId?: string
  snapshotId?: string
  createdAt: string
  kind: string
  state: string
  verdict: string | null
  port?: number
  isDefault: boolean
}
