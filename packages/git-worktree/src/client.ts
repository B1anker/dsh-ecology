import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LocaleService, Services } from './client-contracts.js'
import { DICTS, LOCALE_NS } from './locales.js'
import { SidebarWorktreeGrouper } from './sidebar-worktree-grouper.js'
import { WorktreeButton } from './worktree-control.js'

export const name = '@seaveyon/dsh-git-worktree'
export const inject = ['uiWorkspace', 'workspaces', 'sessions', 'locale']

type MountedControl = { container: HTMLElement; root: Root }

function ensureStyles(): void {
  if (document.querySelector('style[data-dsh-git-worktree-style]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshGitWorktreeStyle = 'true'
  style.textContent = [
    '[data-dsh-git-worktree] .dsh-git-worktree-input{display:flex;width:100%;box-sizing:border-box}',
    '[data-dsh-git-worktree-child]{margin-left:16px!important;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1)}',
    '[data-dsh-git-worktree-child] [role="treeitem"]{position:relative}',
    '[data-dsh-git-worktree-child] [role="treeitem"]::before{content:"";position:absolute;left:-17px;top:50%;width:9px;border-top:1px solid var(--dsw-alias-border-l1)}',
    '[data-dsh-git-worktree-removed]{opacity:0.72}',
    '[data-dsh-git-worktree-removed] [data-dsh-git-worktree-removed-badge]{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
    '[data-dsh-git-worktree-reveal]{margin-left:auto;flex:none;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);width:24px;height:24px;border-radius:6px;padding:0;line-height:1}',
    '[data-dsh-git-worktree-reveal]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
    '[data-dsh-git-worktree-readonly-block]{pointer-events:none;opacity:0.55}',
  ].join('')
  document.head.append(style)
}

function findHost(): HTMLElement | undefined {
  const mode = [...document.querySelectorAll('button')].find((element) =>
    /标准模式|standard mode/i.test(element.textContent ?? ''),
  )
  return mode?.parentElement ?? undefined
}

function mount(services: Services, current?: MountedControl): MountedControl | undefined {
  if (current?.container.isConnected === true) return current
  current?.root.unmount()
  ensureStyles()
  const host = findHost()
  if (host === undefined) return undefined
  const container = document.createElement('span')
  container.dataset.dshGitWorktree = 'true'
  container.style.cssText = 'display:inline-flex;margin-left:6px'
  host.append(container)
  const root = createRoot(container)
  root.render(createElement(WorktreeButton, { services }))
  return { container, root }
}

export function apply(ctx: {
  get(name: string): unknown
  locale?: LocaleService
  effect?(fn: () => (() => void) | void, label?: string): void
}) {
  const services: Services = {
    uiWorkspace: ctx.get('uiWorkspace') as Services['uiWorkspace'],
    workspaces: ctx.get('workspaces') as Services['workspaces'],
    sessions: ctx.get('sessions') as Services['sessions'],
    locale: (ctx.locale ?? ctx.get('locale')) as LocaleService | undefined,
  }
  if (services.locale !== undefined) {
    ctx.effect?.(
      () => services.locale?.register(LOCALE_NS, DICTS),
      'dsh-git-worktree: dictionaries',
    )
  }
  let control = mount(services)
  let mountTimer: number | undefined
  const observer = new MutationObserver(() => {
    // Debounce remounts: full-document observation fires constantly during
    // login/bootstrap React paints and must not remount on every mutation.
    if (mountTimer !== undefined) return
    mountTimer = window.setTimeout(() => {
      mountTimer = undefined
      control = mount(services, control)
    }, 120)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  const stopGrouping = new SidebarWorktreeGrouper(services).start()
  ctx.effect?.(
    () => () => {
      observer.disconnect()
      if (mountTimer !== undefined) window.clearTimeout(mountTimer)
      stopGrouping()
      control?.root.unmount()
      control?.container.remove()
    },
    'dsh-git-worktree: hero mount',
  )
}
