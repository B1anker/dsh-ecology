import type { Services, Workspace, WorkspaceGroupEntry } from './client-contracts.js'
import { serviceTranslate } from './strings.js'
import { inferWorkspaceGroupsLocal, mergeWorkspaceGroups } from './workspace-layout.js'
import { request, showWorktreeToast } from './worktree-api.js'

/** How often to enrich local nesting with server tombstone/branch status. */
const POLL_MS = 30_000
/** Debounce for DOM-only reordering after sidebar mutations. */
const DOM_DEBOUNCE_MS = 80
/** Debounce for path-list changes before local+optional network refresh. */
const DATA_DEBOUNCE_MS = 200
/** Keep network classify short so a stuck connection pool cannot freeze boot. */
const CLASSIFY_TIMEOUT_MS = 4_000

export function workspaceTitle(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

function normalizePathKey(path: string): string {
  return path.replace(/^\/private\/var\//, '/var/')
}

function onLoginSurface(): boolean {
  const path = window.location.pathname
  return path === '/login' || path.startsWith('/login/') || path.startsWith('/auth/')
}

type FileManagerKind = 'finder' | 'explorer' | 'file-manager'

/**
 * The stock WorkspaceBrowser owns the sidebar's only rendering slot.  Moving
 * its live workspace group nodes retains every stock behavior (open, search,
 * session rows, menus, drag ordering) while displaying linked worktrees below
 * their primary checkout.  This intentionally changes only presentation: the
 * Host Workspace registry remains flat and therefore stays compatible with
 * unmodified DSH installs.
 *
 * When a physical worktree disappears, the server leaves a tombstone directory
 * so DSH keeps session membership. This grouper then marks that row removed /
 * read-only: history stays visible, create + continue are blocked, delete remains.
 *
 * Nesting itself is computed locally from `{repo}-worktrees/` paths so a hung
 * `workspace-groups` request can never block login/refresh. The HTTP call only
 * enriches branch/removed status and is skipped on auth surfaces.
 */
export class SidebarWorktreeGrouper {
  private domTimer: number | undefined
  private dataTimer: number | undefined
  private pollTimer: number | undefined
  private disposed = false
  /** True while we mutate the sidebar so MutationObserver does not re-enter. */
  private applying = false
  private lastKey = ''
  private inFlight = false
  private queuedData = false
  private queuedForce = false
  private abort: AbortController | undefined
  private pendingDelete?: { entry: WorkspaceGroupEntry; workspace: Workspace }
  private groups: WorkspaceGroupEntry[] = []
  private readonly removedPaths = new Set<string>()
  private fileManagerKind: FileManagerKind = 'file-manager'
  private lastToastAt = 0
  private notifiedRemovedSession: string | undefined
  private readonly services: Services

  constructor(services: Services) {
    this.services = services
  }

  private notifyReadOnly(): void {
    const now = Date.now()
    if (now - this.lastToastAt < 1500) return
    this.lastToastAt = now
    showWorktreeToast(serviceTranslate(this.services.locale)('removedReadOnly'))
  }

  start(): () => void {
    const refreshData = () => this.scheduleData(false)
    const refreshDom = () => {
      if (this.applying) return
      this.scheduleDom()
    }
    const unsubscribeWorkspaces = this.services.workspaces?.list.subscribe?.(refreshData)
    // Session changes only affect read-only chrome, not path classification.
    const unsubscribeSessions = this.services.sessions?.list.subscribe?.(refreshDom)
    const observer = new MutationObserver(refreshDom)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    const interceptDelete = (event: MouseEvent) => this.interceptDelete(event)
    const interceptCreate = (event: MouseEvent) => this.interceptCreate(event)
    const interceptComposer = (event: Event) => this.interceptComposer(event)
    document.addEventListener('click', interceptDelete, true)
    document.addEventListener('click', interceptCreate, true)
    document.addEventListener('pointerdown', interceptComposer, true)
    document.addEventListener('keydown', interceptComposer, true)
    if (!onLoginSurface()) void this.loadFileManagerKind()
    this.scheduleData(true)
    this.pollTimer = window.setInterval(() => this.scheduleData(true), POLL_MS)
    return () => {
      this.disposed = true
      this.abort?.abort()
      if (this.domTimer !== undefined) window.clearTimeout(this.domTimer)
      if (this.dataTimer !== undefined) window.clearTimeout(this.dataTimer)
      if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer)
      observer.disconnect()
      unsubscribeWorkspaces?.()
      unsubscribeSessions?.()
      document.removeEventListener('click', interceptDelete, true)
      document.removeEventListener('click', interceptCreate, true)
      document.removeEventListener('pointerdown', interceptComposer, true)
      document.removeEventListener('keydown', interceptComposer, true)
      this.clearReadonlyChrome()
    }
  }

  private async loadFileManagerKind(): Promise<void> {
    try {
      const data = await request('/api/plugins/dsh-git-worktree/reveal')
      if (data.kind === 'finder' || data.kind === 'explorer' || data.kind === 'file-manager') {
        this.fileManagerKind = data.kind
      }
    } catch {
      // Keep the generic label when the probe fails.
    }
  }

  private revealLabel(): string {
    const t = serviceTranslate(this.services.locale)
    if (this.fileManagerKind === 'finder') return t('revealInFinder')
    if (this.fileManagerKind === 'explorer') return t('revealInExplorer')
    return t('revealInFileManager')
  }

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

  private interceptCreate(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : undefined
    if (target === undefined) return
    if (target.closest('[data-dsh-git-worktree-reveal]') !== null) return
    const removed = target.closest<HTMLElement>('[data-dsh-git-worktree-removed]')
    if (removed === null) return
    const action = target.closest<HTMLElement>('button, [role="button"]')
    if (action === null) return
    const label = action.textContent?.trim().toLowerCase() ?? ''
    const aria = action.getAttribute('aria-label')?.toLowerCase() ?? ''
    if (/(删除|delete)/i.test(label) || /(删除|delete)/i.test(aria)) return
    if (
      action.closest('[role="menuitem"], [role="menuitemradio"]') !== null &&
      /(删除|delete)/i.test(label)
    )
      return
    if (action.closest('[role="treeitem"]') === null) return
    if (/(删除工作区|delete workspace|重命名|rename)/i.test(label)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.notifyReadOnly()
  }

  private interceptComposer(event: Event): void {
    if (!this.isCurrentSessionRemoved()) return
    const target = event.target instanceof Element ? event.target : undefined
    if (target === undefined) return
    if (
      target.closest(
        'textarea, [contenteditable="true"], [role="textbox"], button[type="submit"]',
      ) === null
    )
      return
    if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey) && event.key === 'c')
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type === 'keydown' || event.type === 'pointerdown') {
      this.notifyReadOnly()
    }
  }

  private scheduleDom(): void {
    if (this.disposed || this.domTimer !== undefined) return
    this.domTimer = window.setTimeout(() => {
      this.domTimer = undefined
      this.applyDom(() => {
        this.reorderFromDocument()
        this.syncReadonlyChrome()
      })
    }, DOM_DEBOUNCE_MS)
  }

  private scheduleData(force: boolean): void {
    if (this.disposed) return
    if (force) this.queuedForce = true
    if (this.dataTimer !== undefined) return
    this.dataTimer = window.setTimeout(() => {
      this.dataTimer = undefined
      const nextForce = this.queuedForce
      this.queuedForce = false
      void this.syncData(nextForce)
    }, DATA_DEBOUNCE_MS)
  }

  private applyDom(fn: () => void): void {
    this.applying = true
    try {
      fn()
    } finally {
      // MutationObserver delivers records after this task; keep the guard until
      // those records are drained so our own inserts do not re-schedule work.
      window.setTimeout(() => {
        this.applying = false
      }, 0)
    }
  }

  private applyLocalGroups(paths: readonly string[]): void {
    this.groups = inferWorkspaceGroupsLocal(paths)
    this.removedPaths.clear()
    for (const entry of this.groups) {
      if (entry.status === 'removed') this.removedPaths.add(normalizePathKey(entry.path))
    }
    this.applyDom(() => {
      this.reorderFromDocument()
      this.syncReadonlyChrome()
    })
  }

  private async syncData(force: boolean): Promise<void> {
    const items = this.services.workspaces?.list.getSnapshot().items ?? []
    const paths = items.flatMap((item) => (item.path === undefined ? [] : [item.path]))
    const key = paths.join('\u0000')

    if (paths.length === 0) {
      this.lastKey = ''
      this.groups = []
      this.removedPaths.clear()
      return
    }

    // Always nest immediately from path layout — never wait on the network.
    if (key !== this.lastKey || this.groups.length === 0) {
      this.lastKey = key
      this.applyLocalGroups(paths)
    } else if (!force) {
      this.applyDom(() => {
        this.reorderFromDocument()
        this.syncReadonlyChrome()
      })
      return
    }

    if (onLoginSurface() || document.visibilityState === 'hidden') return
    if (this.inFlight) {
      this.queuedData = true
      if (force) this.queuedForce = true
      return
    }

    this.inFlight = true
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    try {
      const query = encodeURIComponent(JSON.stringify(paths))
      const data = await request(
        `/api/plugins/dsh-git-worktree/workspace-groups?paths=${query}`,
        undefined,
        { signal: abort.signal, timeoutMs: CLASSIFY_TIMEOUT_MS },
      )
      if (this.disposed || abort.signal.aborted) return
      const remote = Array.isArray(data.items)
        ? data.items.filter(
            (item): item is WorkspaceGroupEntry =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as WorkspaceGroupEntry).path === 'string',
          )
        : []
      this.groups = mergeWorkspaceGroups(inferWorkspaceGroupsLocal(paths), remote)
      this.removedPaths.clear()
      for (const entry of this.groups) {
        if (entry.status === 'removed') this.removedPaths.add(normalizePathKey(entry.path))
      }
      this.applyDom(() => {
        this.reorderFromDocument()
        this.syncReadonlyChrome()
      })
    } catch {
      // Local nesting already applied. A stuck connection pool / 401 / timeout
      // must never block refresh; the next poll retries enrichment only.
    } finally {
      this.inFlight = false
      if (this.queuedData && !this.disposed) {
        this.queuedData = false
        this.scheduleData(this.queuedForce)
      }
    }
  }

  private reorderFromDocument(): void {
    const outline = document.querySelector<HTMLElement>('[role="tree"]')
    if (outline === null || this.groups.length === 0) return

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
      if (entry.status === 'removed') {
        child.dataset.dshGitWorktreeRemoved = 'true'
        childRow?.setAttribute('title', t('removedTooltip'))
        this.ensureRemovedBadge(childRow, t('removedBadge'))
        childRow?.querySelector('[data-dsh-git-worktree-reveal]')?.remove()
      } else {
        delete child.dataset.dshGitWorktreeRemoved
        childRow?.querySelector('[data-dsh-git-worktree-removed-badge]')?.remove()
        if (entry.branch !== undefined)
          childRow?.setAttribute('title', t('branchTooltip', { branch: entry.branch }))
        this.ensureRevealButton(childRow, entry.path)
      }
      if (child.parentElement !== owner || child.previousElementSibling !== ownerRow) {
        ownerRow?.insertAdjacentElement('afterend', child)
      }
      ownerRow?.setAttribute('data-dsh-git-worktree-owner', 'true')
    }
  }

  private ensureRemovedBadge(row: HTMLElement | null | undefined, label: string): void {
    if (row === null || row === undefined) return
    let badge = row.querySelector<HTMLElement>('[data-dsh-git-worktree-removed-badge]')
    if (badge === null) {
      badge = document.createElement('span')
      badge.dataset.dshGitWorktreeRemovedBadge = 'true'
      row.append(badge)
    }
    if (badge.textContent !== label) badge.textContent = label
  }

  private ensureRevealButton(row: HTMLElement | null | undefined, path: string): void {
    if (row === null || row === undefined) return
    let button = row.querySelector<HTMLButtonElement>('[data-dsh-git-worktree-reveal]')
    if (button === null) {
      button = document.createElement('button')
      button.type = 'button'
      button.dataset.dshGitWorktreeReveal = 'true'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const target = event.currentTarget as HTMLButtonElement
        const nextPath = target.dataset.dshGitWorktreeRevealPath
        if (nextPath !== undefined) void this.revealPath(nextPath)
      })
      row.append(button)
    }
    if (button.dataset.dshGitWorktreeRevealPath !== path)
      button.dataset.dshGitWorktreeRevealPath = path
    const label = this.revealLabel()
    if (button.title !== label) button.title = label
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
    if (button.textContent !== '↗') button.textContent = '↗'
  }

  private async revealPath(path: string): Promise<void> {
    const t = serviceTranslate(this.services.locale)
    try {
      await request('/api/plugins/dsh-git-worktree/reveal', { path })
    } catch {
      showWorktreeToast(t('revealFailed'))
    }
  }

  private isCurrentSessionRemoved(): boolean {
    const current = this.services.sessions?.list.getSnapshot().current
    if (current === undefined) return false
    const workspace = (this.services.workspaces?.list.getSnapshot().items ?? []).find((item) =>
      item.sessionIds?.includes(current),
    )
    if (workspace?.path === undefined) return false
    return this.removedPaths.has(normalizePathKey(workspace.path))
  }

  private syncReadonlyChrome(): void {
    const active = this.isCurrentSessionRemoved()
    for (const node of document.querySelectorAll('[data-dsh-git-worktree-readonly-block]')) {
      delete (node as HTMLElement).dataset.dshGitWorktreeReadonlyBlock
    }
    if (!active) {
      this.notifiedRemovedSession = undefined
      return
    }

    const current = this.services.sessions?.list.getSnapshot().current
    if (current !== undefined && this.notifiedRemovedSession !== current) {
      this.notifiedRemovedSession = current
      this.notifyReadOnly()
    }

    for (const node of document.querySelectorAll<HTMLElement>(
      'textarea, [contenteditable="true"], [role="textbox"]',
    )) {
      node.dataset.dshGitWorktreeReadonlyBlock = 'true'
    }
  }

  private clearReadonlyChrome(): void {
    this.notifiedRemovedSession = undefined
    for (const node of document.querySelectorAll('[data-dsh-git-worktree-readonly-block]')) {
      delete (node as HTMLElement).dataset.dshGitWorktreeReadonlyBlock
    }
  }
}
