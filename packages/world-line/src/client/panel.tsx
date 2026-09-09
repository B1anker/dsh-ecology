import { X } from '@phosphor-icons/react/dist/csr/X'
import { type ComponentPropsWithoutRef, type ReactNode, useId } from 'react'

type PanelProps = Omit<ComponentPropsWithoutRef<'form'>, 'title'> & {
  as?: 'aside' | 'form'
  title: ReactNode
  close(): void
  closeDisabled?: boolean
  footer?: ReactNode
}

/** Shared drawer chrome: only the body scrolls, keeping title and actions visible. */
export function Panel({
  as: Surface = 'aside',
  title,
  close,
  closeDisabled,
  footer,
  children,
  className = '',
  ...props
}: PanelProps) {
  const titleId = useId()
  return (
    <Surface {...props} className={`${className} wl-panel`} aria-labelledby={titleId}>
      <header className="wl-panel-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="wl-button wl-icon"
          aria-label="关闭"
          disabled={closeDisabled}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <div className="wl-panel-body">{children}</div>
      {footer && <footer className="wl-panel-footer">{footer}</footer>}
    </Surface>
  )
}
