import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

/** Screen-space tooltip: independent of the canvas transform and clipping. */
export function TooltipButton({
  tooltipTitle,
  tooltipDescription,
  tooltipAction,
  tooltipColor,
  children,
  ...props
}: ComponentProps<'button'> & {
  tooltipTitle: ReactNode
  tooltipDescription?: ReactNode
  tooltipAction?: string
  tooltipColor?: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const action = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false })
  const cancel = () => clearTimeout(timer.current)
  const hide = () => {
    cancel()
    setOpen(false)
  }
  const leave = () => {
    cancel()
    timer.current = setTimeout(() => {
      if (!popup.current?.contains(document.activeElement)) setOpen(false)
    }, 200)
  }
  const show = (delay: number) => {
    cancel()
    timer.current = setTimeout(() => {
      setPosition({ left: 0, top: 0, ready: false })
      setOpen(true)
    }, delay)
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return
    const rect = trigger.current.getBoundingClientRect()
    const size = popup.current.getBoundingClientRect()
    const above = rect.top - size.height - 12
    setPosition({
      left: Math.max(
        12,
        Math.min(innerWidth - size.width - 12, rect.left + rect.width / 2 - size.width / 2),
      ),
      top: Math.max(
        12,
        Math.min(innerHeight - size.height - 12, above >= 12 ? above : rect.bottom + 12),
      ),
      ready: true,
    })
  }, [open, tooltipTitle, tooltipDescription])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && popup.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        hide()
      }
    }
    window.addEventListener('keydown', escape, true)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      cancel()
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])
  return (
    <>
      <button
        {...props}
        ref={trigger}
        aria-describedby={open ? id : undefined}
        aria-haspopup={tooltipAction ? 'dialog' : undefined}
        aria-expanded={tooltipAction ? open : undefined}
        onKeyDown={(event) => {
          if (open && event.key === 'Tab' && !event.shiftKey && action.current) {
            event.preventDefault()
            action.current.focus()
          }
          props.onKeyDown?.(event)
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') show(250)
          props.onPointerEnter?.(event)
        }}
        onPointerLeave={(event) => {
          leave()
          props.onPointerLeave?.(event)
        }}
        onFocus={(event) => {
          show(0)
          props.onFocus?.(event)
        }}
        onBlur={(event) => {
          if (!popup.current?.contains(event.relatedTarget as Node)) hide()
          props.onBlur?.(event)
        }}
        onPointerDown={(event) => {
          hide()
          props.onPointerDown?.(event)
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            role={tooltipAction ? 'dialog' : 'tooltip'}
            aria-modal={tooltipAction ? false : undefined}
            aria-labelledby={`${id}-title`}
            id={id}
            className="wl-hud-tooltip"
            style={
              {
                '--wl-tooltip-color': tooltipColor ?? '#2999d0',
                left: position.left,
                top: position.top,
                visibility: position.ready ? 'visible' : 'hidden',
              } as CSSProperties
            }
            onPointerEnter={cancel}
            onPointerLeave={leave}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) hide()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault()
                trigger.current?.focus()
              }
            }}
          >
            <strong id={`${id}-title`}>{tooltipTitle}</strong>
            {tooltipDescription && <div>{tooltipDescription}</div>}
            {tooltipAction && (
              <button
                ref={action}
                type="button"
                className="wl-tooltip-action"
                disabled={props.disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  hide()
                  trigger.current?.click()
                }}
              >
                {tooltipAction} <span aria-hidden="true">→</span>
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
