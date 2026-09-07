/** Browser-safe projections: no raw config values, credentials or filesystem paths. */
export interface WorldEvent {
  id: string
  lineId: string
  at: string
  kind: 'created' | 'snapshot' | 'verification'
  title: string
  detail: string
  snapshotId?: string
  restorable?: boolean
}
export interface WorldComparison {
  at: string
  from: string
  to: string
  dependencies: { name: string; before: string; after: string; status: string; changes: string[] }[]
  files: { name: string; status: string }[]
  patches: { file: string; key: string; status: string }[]
  bundles: { before: string[]; after: string[] }
  warnings: string[]
}
export interface SnapshotDetail {
  id: string
  at: string
  label: string
  dependencies: { name: string; version: string }[]
  files: { name: string; stored: boolean }[]
  restorable: boolean
  warnings: string[]
}
