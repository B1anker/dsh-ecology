export interface MergePreview {
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
  revision: string
  plugins: {
    name: string
    before: string
    after: string
    changed: boolean
    removable: boolean
    blocked?: string
  }[]
  configChanged: boolean
}
export interface MergeCandidate {
  id: string
  labId: string
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
  plugins: string[]
  packageVersions?: { name: string; version: string }[]
  includeConfig: boolean
  ok: boolean
  reviewable?: boolean
  reviewAccepted?: boolean
  detail: string
  committed?: boolean
  committedAt?: string
  preSnapshot?: string
}
