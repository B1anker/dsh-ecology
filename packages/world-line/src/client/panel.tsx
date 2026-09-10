import { ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft'
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
} from 'react'
import { CloseButton } from './close-button.js'

const panelStack: HTMLElement[] = []

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
  const surface = useRef<HTMLElement | null>(null)
  const dismiss = useRef({ close, closeDisabled })
  dismiss.current = { close, closeDisabled }
  useEffect(() => {
    const element = surface.current
    if (!element) return
    panelStack.push(element)
    const outside = (event: PointerEvent) => {
      if (panelStack[panelStack.length - 1] !== element || dismiss.current.closeDisabled) return
      const target = event.target
      if (!(target instanceof Element) || element.contains(target)) return
      // Portaled menus and selects belong to their owning panel.
      if (target.closest('.wl-menu-layer,[role=listbox],[role=menu],.wl-hud-popup')) return
      // Let other controls navigate normally; dismiss on the surrounding blank surface.
      if (target.closest('button,a,input,textarea,select,[role=button],[role=tab]')) return
      dismiss.current.close()
    }
    document.addEventListener('pointerdown', outside)
    return () => {
      const index = panelStack.indexOf(element)
      if (index !== -1) panelStack.splice(index, 1)
      document.removeEventListener('pointerdown', outside)
    }
  }, [])
  const titleId = useId()
  const navigationBack = useContext(PanelNavigation)
  const goBack = back ?? navigationBack
  return (
    <Surface
      {...props}
      ref={(element) => {
        surface.current = element
      }}
      className={`${className} wl-panel`}
      aria-labelledby={titleId}
    >
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
        <CloseButton disabled={closeDisabled} onClick={close} />
      </header>
      <div className="wl-panel-body">{children}</div>
      {footer && <footer className="wl-panel-footer">{footer}</footer>}
    </Surface>
  )
}
