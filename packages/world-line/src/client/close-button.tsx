import { X } from '@phosphor-icons/react/dist/csr/X'
import type { ComponentPropsWithoutRef } from 'react'

/** Shared SAO close control for panels, menus and transient notices. */
export function CloseButton({ className = '', ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button type="button" aria-label="关闭" {...props} className={`wl-close-button ${className}`}>
      <X size={15} weight="light" aria-hidden="true" />
    </button>
  )
}
