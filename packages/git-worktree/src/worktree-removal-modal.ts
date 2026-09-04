import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, type ReactElement } from 'react'
import type { Translate, Workspace, WorkspaceGroupEntry } from './client-contracts.js'
import { workspaceTitle } from './sidebar-worktree-grouper.js'

export type RemovalTarget = { entry: WorkspaceGroupEntry; workspace: Workspace }

type Props = {
  target?: RemovalTarget
  removing: boolean
  error?: string
  t: Translate
  onClose(): void
  onRemove(): void
}

/** Destructive worktree removal stays isolated from the create-picker state. */
export function WorktreeRemovalModal({
  target,
  removing,
  error,
  t,
  onClose,
  onRemove,
}: Props): ReactElement {
  return createElement(
    Modal,
    {
      open: target !== undefined,
      onClose: () => {
        if (!removing) onClose()
      },
      title: t('deleteWorktree'),
      closeLabel: t('cancel'),
      footer: createElement(
        'span',
        { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', width: '100%' } },
        [
          createElement(
            Button,
            {
              key: 'cancel',
              type: 'button',
              variant: 'outline',
              disabled: removing,
              onClick: onClose,
            },
            t('cancel'),
          ),
          createElement(
            Button,
            {
              key: 'delete',
              type: 'button',
              variant: 'primary',
              disabled: removing,
              onClick: onRemove,
            },
            removing ? t('deleting') : t('deleteWorktree'),
          ),
        ],
      ),
    },
    [
      target === undefined
        ? null
        : createElement(
            'p',
            { key: 'message', style: { margin: 0, lineHeight: '22px' } },
            t('deleteConfirm', {
              branch: target.entry.branch ?? workspaceTitle(target.entry.path),
            }),
          ),
      target === undefined
        ? null
        : createElement(
            'code',
            {
              key: 'path',
              style: {
                display: 'block',
                marginTop: '10px',
                color: 'var(--dsw-alias-label-tertiary)',
                overflowWrap: 'anywhere',
              },
            },
            target.entry.path,
          ),
      error === undefined
        ? null
        : createElement(
            'p',
            {
              key: 'error',
              role: 'alert',
              style: { margin: '10px 0 0', color: 'var(--dsw-alias-state-error)' },
            },
            error,
          ),
    ],
  )
}
