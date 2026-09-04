import type { Services, Workspace, WorkspaceGroupEntry } from './client-contracts.js'
import { serviceTranslate } from './strings.js'
import { request } from './worktree-api.js'

export function workspaceTitle(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

/**
 * The stock WorkspaceBrowser owns the sidebar's only rendering slot.  Moving
 * its live workspace group nodes retains every stock behavior (open, search,
 * session rows, menus, drag ordering) while displaying linked worktrees below
 * their primary checkout.  This intentionally changes only presentation: the
 * Host Workspace registry remains flat and therefore stays compatible with
 * unmodified DSH installs.
 */
export class SidebarWorktreeGrouper {
  private timer: number | undefined
  private disposed = false
  private lastKey = ''
  private pendingDelete?: { entry: WorkspaceGroupEntry; workspace: Workspace }

  constructor(private readonly services: Services) {}

  start(): () => void {
    const refresh = () => this.schedule()
    const unsubscribe = this.services.workspaces?.list.subscribe?.(refresh)
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    const interceptDelete = (event: MouseEvent) => this.interceptDelete(event)
    document.addEventListener('click', interceptDelete, true)
    this.schedule()
    return () => {
      this.disposed = true
      if (this.timer !== undefined) window.clearTimeout(this.timer)
      observer.disconnect()
      unsubscribe?.()
      document.removeEventListener('click', interceptDelete, true)
    }
  }

  /**
   * Keep the stock row chrome intact. When its existing “Delete workspace”
   * action targets a linked worktree, replace only that action with our
   * physical Git deletion confirmation instead of adding another row button.
   */
  private interceptDelete(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : undefined
    if (target === undefined) return
    const workspaceRow = target.closest<HTMLElement>('[data-dsh-git-worktree-path]')
    if (workspaceRow !== null) {
      const path = workspaceRow.dataset.dshGitWorktreePath
      const entry = this.groups.find((candidate) => candidate.path === path)
      const workspace = (this.services.workspaces?.list.getSnapshot().items ?? []).find(
        (candidate) => candidate.path === path,
      )
      if (entry !== undefined && workspace !== undefined) this.pendingDelete = { entry, workspace }
    }

    const action = target.closest<HTMLElement>('[role="menuitem"], [role="menuitemradio"], button')
    const label = action?.textContent?.trim().toLowerCase() ?? ''
    if (this.pendingDelete === undefined || !/(删除工作区|delete workspace)/i.test(label)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.dispatchEvent(new CustomEvent('dsh-git-worktree:remove', { detail: this.pendingDelete }))
    this.pendingDelete = undefined
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      void this.sync()
    }, 80)
  }

  private async sync(): Promise<void> {
    const items = this.services.workspaces?.list.getSnapshot().items ?? []
    const paths = items.flatMap((item) => (item.path === undefined ? [] : [item.path]))
    const key = paths.join('\u0000')
    if (paths.length === 0 || key === this.lastKey) {
      this.reorderFromDocument()
      return
    }
    try {
      const data = await request('/api/plugins/dsh-git-worktree/workspace-groups', { paths })
      const entries = Array.isArray(data.items)
        ? data.items.filter(
            (item): item is WorkspaceGroupEntry =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as WorkspaceGroupEntry).path === 'string',
          )
        : []
      this.lastKey = key
      this.groups = entries
      this.reorderFromDocument()
    } catch {
      // Grouping is strictly a visual enhancement.  Keep the stock sidebar
      // untouched if a browser reconnect temporarily loses the endpoint.
    }
  }

  private groups: WorkspaceGroupEntry[] = []

  private reorderFromDocument(): void {
    // Accessibility exposes this as an outline on macOS, while DSH's DOM
    // correctly uses the ARIA tree/treeitem roles.
    const outline = document.querySelector<HTMLElement>('[role="tree"]')
    if (outline === null || this.groups.length === 0) return

    // WorkspaceBrowser renders each workspace as one direct outline child:
    // a row plus its session descendants.  We only move that outer element,
    // never a React-managed descendant, so existing event wiring remains live.
    const groupNodes = [...outline.children].filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.querySelector('[role="treeitem"]') !== null,
    )
    const nodeForPath = (path: string): HTMLElement | undefined => {
      const title = workspaceTitle(path)
      return groupNodes.find((node) => {
        const row = node.querySelector<HTMLElement>('[role="treeitem"]')
        return row?.textContent?.trim().startsWith(title) === true
      })
    }

    const primary = new Map<string, HTMLElement>()
    const t = serviceTranslate(this.services.locale)
    for (const entry of this.groups) {
      if (entry.repositoryPath === entry.path) {
        const node = nodeForPath(entry.path)
        if (node !== undefined) primary.set(entry.path, node)
      }
    }
    for (const entry of this.groups) {
      if (entry.repositoryPath === undefined || entry.repositoryPath === entry.path) continue
      const owner = primary.get(entry.repositoryPath)
      const child = nodeForPath(entry.path)
      if (owner === undefined || child === undefined || owner === child) continue
      if (child.dataset.dshGitWorktreeRemoving === 'true') continue

      const ownerRow = owner.querySelector<HTMLElement>('[role="treeitem"]')
      const childRow = child.querySelector<HTMLElement>('[role="treeitem"]')
      owner.dataset.dshGitWorktreeParent = 'true'
      child.dataset.dshGitWorktreeChild = 'true'
      child.dataset.dshGitWorktreePath = entry.path
      if (entry.branch !== undefined)
        childRow?.setAttribute('title', t('branchTooltip', { branch: entry.branch }))
      // Nest ahead of the primary checkout's own session rows, matching the
      // mental model “repository → worktree → sessions”. Native row click
      // handlers and the full stock session subtree move together.
      if (child.parentElement !== owner || child.previousElementSibling !== ownerRow) {
        ownerRow?.insertAdjacentElement('afterend', child)
      }
      ownerRow?.setAttribute('data-dsh-git-worktree-owner', 'true')
    }
  }
}
