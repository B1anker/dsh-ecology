import { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft'
import { X } from '@phosphor-icons/react/dist/csr/X'
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useId,
} from 'react'

export const PanelNavigation = createContext<(() => void) | null>(null)

type PanelProps = Omit<ComponentPropsWithoutRef<'form'>, 'title'> & {
  as?: 'aside' | 'form'
  title: ReactNode
  close(): void
  closeDisabled?: boolean
  footer?: ReactNode
  back?: () => void
}

/** Shared drawer chrome: only the body scrolls, keeping title and actions visible. */
export function Panel({
  as: Surface = 'aside',
  title,
  close,
  closeDisabled,
  footer,
  back,
  children,
  className = '',
  ...props
}: PanelProps) {
  const titleId = useId()
  const navigationBack = useContext(PanelNavigation)
  const goBack = back ?? navigationBack
  return (
    <Surface {...props} className={`${className} wl-panel`} aria-labelledby={titleId}>
      <header className="wl-panel-header">
        {goBack && (
          <button
            type="button"
            className="wl-button wl-icon wl-panel-back"
            onClick={goBack}
            aria-label="返回上个面板"
            title="返回上个面板"
            disabled={closeDisabled}
          >
            <ArrowLeft size={18} />
          </button>
        )}
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
