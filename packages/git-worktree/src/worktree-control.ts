import {
  Button,
  IconBranchOutline16,
  IconChevronLeftOutline14,
  IconSearchOutline16,
  IconWarningOutline16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Branch,
  Services,
  Workspace,
  WorkspaceGroupEntry,
  WorktreeConflict,
} from './client-contracts.js'
import { useStrings } from './strings.js'
import {
  branchOrder,
  currentWorkspace,
  errorMessage,
  parseConflict,
  request,
} from './worktree-api.js'
import { type RemovalTarget, WorktreeRemovalModal } from './worktree-removal-modal.js'

export function WorktreeButton({ services }: { services: Services }) {
  const t = useStrings(services.locale)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [branches, setBranches] = useState<Branch[]>([])
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [baseRef, setBaseRef] = useState<string>()
  const [branch, setBranch] = useState('')
  const [conflict, setConflict] = useState<WorktreeConflict>()
  const [removeTarget, setRemoveTarget] = useState<RemovalTarget>()
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string>()
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const receiveRemoveRequest = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (typeof detail !== 'object' || detail === null) return
      const value = detail as { entry?: WorkspaceGroupEntry; workspace?: Workspace }
      if (value.entry?.path === undefined || value.workspace?.workspaceId === undefined) return
      setRemoveError(undefined)
      setRemoveTarget({ entry: value.entry, workspace: value.workspace })
    }
    window.addEventListener('dsh-git-worktree:remove', receiveRemoveRequest)
    return () => window.removeEventListener('dsh-git-worktree:remove', receiveRemoveRequest)
  }, [])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const filteredBranches = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return branches
      .filter(
        (candidate) => normalized.length === 0 || candidate.name.toLowerCase().includes(normalized),
      )
      .toSorted(branchOrder)
  }, [branches, query])

  const loadBranches = async () => {
    const workspace = currentWorkspace(services)
    if (workspace?.path === undefined) {
      setError(t('selectGitWorkspace'))
      return
    }
    setError(undefined)
    setLoading(true)
    try {
      const data = await request('/api/plugins/dsh-git-worktree/branches', { cwd: workspace.path })
      const list = Array.isArray(data.branches)
        ? data.branches.filter(
            (candidate): candidate is Branch =>
              typeof candidate === 'object' &&
              candidate !== null &&
              typeof (candidate as Branch).name === 'string',
          )
        : []
      setBranches(list)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) {
      setQuery('')
      setConflict(undefined)
      void loadBranches()
    }
  }

  const create = async (overwrite = false) => {
    const workspace = currentWorkspace(services)
    const nextBranch = branch.trim()
    if (baseRef === undefined) return
    if (
      workspace?.path === undefined ||
      services.workspaces === undefined ||
      services.uiWorkspace === undefined
    ) {
      setError(t('selectGitWorkspace'))
      return
    }
    setCreating(true)
    setError(undefined)
    try {
      if (!overwrite && nextBranch.length > 0) {
        const inspected = await request('/api/plugins/dsh-git-worktree/create-conflict', {
          cwd: workspace.path,
          branch: nextBranch,
        })
        const nextConflict = parseConflict(inspected)
        if (nextConflict.directoryExists || nextConflict.branchExists) {
          setConflict(nextConflict)
          return
        }
      }
      const made = await request('/api/plugins/dsh-git-worktree/create', {
        cwd: workspace.path,
        baseRef,
        ...(nextBranch.length > 0 ? { branch: nextBranch } : {}),
        ...(overwrite ? { overwrite: true } : {}),
      })
      const created = await services.workspaces.create({ path: String(made.path) })
      services.uiWorkspace.startSession(created.workspaceId)
      setOpen(false)
      setConflict(undefined)
    } catch (reason) {
      // The preflight panel carries actionable conflict information. Avoid
      // leaking an unhelpful concatenated Git stderr line into the product UI.
      setError(
        reason instanceof Error && reason.message.includes('Cannot overwrite')
          ? reason.message
          : t('createFailed'),
      )
      setOpen(true)
    } finally {
      setCreating(false)
    }
  }

  const remove = async () => {
    if (removeTarget === undefined || services.workspaces?.delete === undefined) return
    setRemoving(true)
    setRemoveError(undefined)
    try {
      // React owns the stock tree's original sibling relationship. Restore it
      // before its Workspace deletion reconcile runs; otherwise deleting a
      // moved child can make React discard the host group as an invalid tree.
      const tree = document.querySelector<HTMLElement>('[role="tree"]')
      const moved = [
        ...document.querySelectorAll<HTMLElement>('[data-dsh-git-worktree-path]'),
      ].find((node) => node.dataset.dshGitWorktreePath === removeTarget.entry.path)
      if (tree !== null && moved !== undefined) {
        moved.dataset.dshGitWorktreeRemoving = 'true'
        tree.append(moved)
      }
      await request('/api/plugins/dsh-git-worktree/remove', { cwd: removeTarget.entry.path })
      await services.workspaces.delete(removeTarget.workspace.workspaceId)
      setRemoveTarget(undefined)
    } catch {
      const moved = [
        ...document.querySelectorAll<HTMLElement>('[data-dsh-git-worktree-path]'),
      ].find((node) => node.dataset.dshGitWorktreePath === removeTarget.entry.path)
      if (moved !== undefined) delete moved.dataset.dshGitWorktreeRemoving
      setRemoveError(t('deleteFailed'))
    } finally {
      setRemoving(false)
    }
  }

  const trigger = createElement(
    Button,
    {
      type: 'button',
      // The conversation hero is not a toolbar. Ghost keeps the background
      // transparent and delegates hover/active colors to the current theme.
      variant: 'ghost',
      size: 'sm',
      icon: createElement(IconBranchOutline16),
      disabled: creating,
      'aria-expanded': open,
      'aria-label': t('newWorktree'),
      onClick: toggle,
    },
    creating ? t('creating') : t('newWorktree'),
  )

  const list = loading
    ? createElement(
        'p',
        { style: { margin: 0, padding: '8px', color: 'var(--dsw-alias-label-tertiary)' } },
        t('loadingBranches'),
      )
    : filteredBranches.length === 0
      ? createElement(
          'p',
          { style: { margin: 0, padding: '8px', color: 'var(--dsw-alias-label-tertiary)' } },
          t('noBranches'),
        )
      : filteredBranches.map((candidate) =>
          createElement(
            Button,
            {
              key: candidate.name,
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              icon: createElement(IconBranchOutline16),
              disabled: creating,
              'aria-pressed': baseRef === candidate.name,
              onClick: () => {
                setBaseRef(candidate.name)
                setBranch('')
                setConflict(undefined)
                setError(undefined)
              },
              style: {
                width: '100%',
                justifyContent: 'flex-start',
                paddingInline: '8px',
                fontFamily: 'var(--dsw-font-mono)',
              },
            },
            candidate.name,
          ),
        )

  const targetPanel = createElement(
    'div',
    {
      key: 'target',
      style: { width: '50%', flex: '0 0 50%', boxSizing: 'border-box', padding: '12px' },
    },
    [
      createElement(
        'div',
        {
          key: 'heading',
          style: {
            padding: '2px 4px 10px',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '13px',
          },
        },
        t('targetBranch'),
      ),
      createElement(Input, {
        key: 'search',
        className: 'dsh-git-worktree-input',
        type: 'search',
        value: query,
        placeholder: t('searchBranch'),
        icon: createElement(IconSearchOutline16),
        'aria-label': t('searchBranch'),
        onChange: (event) => setQuery(event.currentTarget.value),
      }),
      createElement(
        'div',
        {
          key: 'list',
          role: 'listbox',
          'aria-label': t('targetBranchList'),
          style: { maxHeight: '252px', overflowY: 'auto', marginTop: '8px' },
        },
        list,
      ),
      error === undefined
        ? null
        : createElement(
            'p',
            {
              key: 'error',
              role: 'alert',
              style: {
                margin: '8px 4px 0',
                color: 'var(--dsw-alias-state-error)',
                fontSize: '12px',
              },
            },
            error,
          ),
    ],
  )

  const newBranchPanel = createElement(
    'div',
    {
      key: 'new-branch',
      // The picker keeps a fixed height for the searchable branch list. Use a
      // column here so the primary action occupies its natural footer position
      // instead of leaving a blank block beneath it on the shorter form.
      style: {
        width: '50%',
        flex: '0 0 50%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: '12px',
      },
    },
    [
      createElement(
        Button,
        {
          key: 'back',
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          icon: createElement(IconChevronLeftOutline14),
          onClick: () => {
            setBaseRef(undefined)
            setConflict(undefined)
          },
          style: { justifySelf: 'start', marginLeft: '-6px' },
        },
        t('chooseTarget'),
      ),
      createElement('div', { key: 'source' }, [
        createElement(
          'div',
          {
            key: 'label',
            style: {
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: '12px',
              marginBottom: '5px',
            },
          },
          t('targetBranch'),
        ),
        createElement(
          'div',
          {
            key: 'value',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              color: 'var(--dsw-alias-label-primary)',
              fontFamily: 'var(--dsw-font-mono)',
              fontSize: '13px',
            },
          },
          [createElement(IconBranchOutline16, { key: 'icon' }), baseRef],
        ),
      ]),
      createElement('div', { key: 'input-group', style: { display: 'grid', gap: '6px' } }, [
        createElement(
          'label',
          { key: 'label', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' } },
          t('newBranch'),
        ),
        createElement(Input, {
          key: 'input',
          className: 'dsh-git-worktree-input',
          value: branch,
          placeholder: t('newBranchPlaceholder'),
          'aria-label': t('newBranch'),
          onChange: (event) => {
            setBranch(event.currentTarget.value)
            setConflict(undefined)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') void create()
          },
        }),
        createElement(
          'span',
          {
            key: 'hint',
            style: {
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: '12px',
              lineHeight: '18px',
            },
          },
          t('detachedHint'),
        ),
      ]),
      conflict === undefined
        ? null
        : createElement(
            'div',
            {
              key: 'conflict',
              role: 'alert',
              // Deliberately no inner padding: this is an inline warning in the form,
              // not a second card nested inside the picker.
              style: {
                display: 'grid',
                gap: '8px',
                padding: 0,
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '12px',
                lineHeight: '18px',
              },
            },
            [
              createElement(
                'div',
                {
                  key: 'warning-copy',
                  style: {
                    display: 'grid',
                    gap: '8px',
                    paddingInlineStart: '10px',
                    borderLeft: '2px solid var(--dsw-alias-state-warning-primary, #b45309)',
                  },
                },
                [
                  createElement(
                    'strong',
                    {
                      key: 'title',
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        color: 'var(--dsw-alias-state-warning-primary, #b45309)',
                      },
                    },
                    [createElement(IconWarningOutline16, { key: 'icon' }), t('conflictTitle')],
                  ),
                  createElement(
                    'span',
                    { key: 'body' },
                    t('conflictBody', { branch: branch.trim() }),
                  ),
                  createElement(
                    'span',
                    {
                      key: 'path',
                      style: {
                        color: 'var(--dsw-alias-label-tertiary)',
                        fontFamily: 'var(--dsw-font-mono)',
                        overflowWrap: 'anywhere',
                      },
                    },
                    conflict.targetPath,
                  ),
                ],
              ),
              createElement(
                'span',
                {
                  key: 'actions',
                  style: { display: 'flex', justifyContent: 'flex-end', gap: '6px' },
                },
                [
                  createElement(
                    Button,
                    {
                      key: 'cancel',
                      type: 'button',
                      variant: 'ghost',
                      size: 'sm',
                      disabled: creating,
                      onClick: () => setConflict(undefined),
                    },
                    t('cancel'),
                  ),
                  createElement(
                    Button,
                    {
                      key: 'overwrite',
                      type: 'button',
                      variant: 'primary',
                      size: 'sm',
                      disabled: creating,
                      onClick: () => {
                        void create(true)
                      },
                    },
                    creating ? t('overwriting') : t('overwrite'),
                  ),
                ],
              ),
            ],
          ),
      error === undefined
        ? null
        : createElement(
            'p',
            {
              key: 'error',
              role: 'alert',
              style: { margin: 0, color: 'var(--dsw-alias-state-error)', fontSize: '12px' },
            },
            error,
          ),
      // A conflict card owns its explicit Cancel / Overwrite actions. Rendering
      // the ordinary footer as well makes the destructive state ambiguous and
      // creates an unnecessary empty panel below it.
      conflict === undefined
        ? createElement(
            Button,
            {
              key: 'create',
              type: 'button',
              variant: 'primary',
              disabled: creating,
              onClick: () => {
                void create()
              },
              style: { width: '100%' },
            },
            creating ? t('updating') : t('create'),
          )
        : null,
    ],
  )

  const popover = createElement(
    'section',
    {
      key: 'popover',
      role: 'dialog',
      'aria-label': t('createDialog'),
      style: {
        position: 'absolute',
        zIndex: 100,
        top: 'calc(100% + 6px)',
        left: 0,
        width: '340px',
        // Conflict confirmation adds a destructive-action explanation and must
        // never be clipped by the compact branch-picker height. On a short
        // viewport the panel itself scrolls, leaving both actions reachable.
        height:
          baseRef === undefined
            ? '350px'
            : conflict === undefined
              ? '240px'
              : 'min(350px, calc(100vh - 180px))',
        overflowX: 'hidden',
        overflowY: conflict === undefined ? 'hidden' : 'auto',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-specific-menu)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        transition: 'height 160ms cubic-bezier(.2,.8,.2,1)',
      },
    },
    createElement(
      'div',
      {
        style: {
          width: '200%',
          height: '100%',
          display: 'flex',
          transform: baseRef === undefined ? 'translateX(0)' : 'translateX(-50%)',
          transition: 'transform 180ms cubic-bezier(.2,.8,.2,1)',
        },
      },
      [targetPanel, newBranchPanel],
    ),
  )

  const removeModal = createElement(WorktreeRemovalModal, {
    target: removeTarget,
    removing,
    error: removeError,
    t,
    onClose: () => setRemoveTarget(undefined),
    onRemove: () => {
      void remove()
    },
  })

  return createElement(
    'span',
    {
      ref: rootRef,
      style: { position: 'relative', display: 'inline-flex' },
    },
    [trigger, open ? popover : null, removeModal],
  )
}
