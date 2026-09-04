import type { WorktreeCopy } from './locales.js'

export type Branch = { name: string; current?: boolean }
export type Workspace = { workspaceId: string; path?: string; sessionIds?: string[] }
export type WorkspaceGroupEntry = {
  path: string
  repositoryPath?: string
  branch?: string
  detached?: boolean
}
export type WorktreeConflict = {
  targetPath: string
  directoryExists: boolean
  branchExists: boolean
}
export type LocaleService = {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}
export type Services = {
  uiWorkspace?: { startSession(id: string): void }
  workspaces?: {
    list: {
      getSnapshot(): { items: Workspace[] }
      subscribe?(listener: () => void): () => void
    }
    create(input: { path: string }): Promise<Workspace>
    delete?(workspaceId: string): Promise<void>
  }
  sessions?: { list: { getSnapshot(): { current?: string } } }
  locale?: LocaleService
}
export type Translate = (
  key: keyof WorktreeCopy,
  params?: Record<string, string | number>,
) => string
