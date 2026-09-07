import { CaretLeft } from '@phosphor-icons/react/dist/csr/CaretLeft'
import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight'
import { X } from '@phosphor-icons/react/dist/csr/X'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { menuPosition } from './menu-position.js'

export interface MenuAction {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  hint?: string
  danger?: boolean
  run?(): void
  children?: MenuAction[]
}
export function ContextMenu({
  x,
  y,
  title,
  subtitle,
  status,
  items,
  host,
  close,
}: {
  x: number
  y: number
  title: string
  subtitle: string
  status: string
  items: MenuAction[]
  host: HTMLElement
  close(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const child = useRef<HTMLDivElement>(null)
  const parent = useRef<HTMLButtonElement | null>(null)
  const focusChild = useRef(false)
  const closeRef = useRef(close)
  closeRef.current = close
  const [group, setGroup] = useState<string | null>(null)
  const [placement, setPlacement] = useState<CSSProperties>({ visibility: 'hidden' })
  const [subPlacement, setSubPlacement] = useState<CSSProperties>({ visibility: 'hidden' })
  const [flipped, setFlipped] = useState(false)
  const [compact, setCompact] = useState(false)
  const selectedGroup = items.find((item) => item.id === group)
  const limits = () => {
    const r = host.getBoundingClientRect()
    return {
      left: Math.max(8, r.left + 8),
      top: Math.max(8, r.top + 8),
      right: Math.min(innerWidth - 8, r.right - 8),
      bottom: Math.min(innerHeight - 8, r.bottom - 8),
    }
  }
  useLayoutEffect(() => {
    if (!main.current) return
    const bounds = limits()
    const size = main.current.getBoundingClientRect()
    const result = menuPosition({ left: x, right: x, top: y }, size, bounds)
    setCompact(
      bounds.right - bounds.left < 500 ||
        Math.max(result.left - bounds.left, bounds.right - result.left - size.width) < 248,
    )
    setPlacement({
      left: result.left,
      top: result.top,
      maxHeight: bounds.bottom - bounds.top,
      maxWidth: bounds.right - bounds.left,
    })
  }, [x, y, host, compact, group])
  useLayoutEffect(() => {
    if (!selectedGroup || compact || !parent.current || !child.current) return
    const result = menuPosition(
      {
        left:
          main.current?.getBoundingClientRect().left ?? parent.current.getBoundingClientRect().left,
        right:
          main.current?.getBoundingClientRect().right ??
          parent.current.getBoundingClientRect().right,
        top:
          parent.current.getBoundingClientRect().top -
          (child.current.querySelector<HTMLElement>('[role=menuitem]')?.offsetTop ?? 0),
      },
      child.current.getBoundingClientRect(),
      limits(),
      true,
    )
    setSubPlacement({ left: result.left, top: result.top })
    setFlipped(result.flipped)
  }, [selectedGroup, compact])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    main.current
      ?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')
      ?.focus({ preventScroll: true })
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current()
    }
    const resize = () => closeRef.current()
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', resize)
      if (
        previous?.isConnected &&
        (root.current?.contains(document.activeElement) || document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    if (!group || !focusChild.current) return
    focusChild.current = false
    ;(compact ? main.current : child.current)
      ?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')
      ?.focus({ preventScroll: true })
  }, [group, compact])
  const back = () => {
    setGroup(null)
    if (compact) {
      const id = group
      requestAnimationFrame(() => {
        Array.from(main.current?.querySelectorAll<HTMLElement>('[data-action]') ?? [])
          .find((item) => item.dataset.action === id)
          ?.focus({ preventScroll: true })
      })
    } else parent.current?.focus({ preventScroll: true })
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>, submenu = false) => {
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && submenu)) {
      event.preventDefault()
      event.stopPropagation()
      if (group) back()
      else close()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      close()
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      const controls = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)'),
      )
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      controls[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? controls.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length
      ]?.focus()
    }
  }
  const buttons = (actions: MenuAction[], submenu = false) =>
    actions.map((item) => (
      <button
        type="button"
        role="menuitem"
        key={item.id}
        disabled={item.disabled}
        title={item.hint}
        data-action={item.id}
        className="wl-system-item"
        data-danger={!!item.danger}
        aria-haspopup={item.children ? 'menu' : undefined}
        aria-expanded={item.children ? group === item.id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse' || submenu || compact) return
          if (item.children) {
            parent.current = event.currentTarget
            setGroup(item.id)
          } else setGroup(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && item.children) {
            event.preventDefault()
            event.stopPropagation()
            parent.current = event.currentTarget
            focusChild.current = true
            setGroup(item.id)
            if (group === item.id)
              child.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus()
          }
        }}
        onClick={(event) => {
          if (item.children) {
            parent.current = event.currentTarget
            focusChild.current = true
            setGroup(item.id)
            if (group === item.id)
              (compact ? main.current : child.current)
                ?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')
                ?.focus({ preventScroll: true })
            return
          }
          close()
          item.run?.()
        }}
      >
        <span className="wl-system-icon" aria-hidden="true">
          {item.icon}
        </span>
        <CaretLeft size={12} weight="fill" className="wl-system-pointer" aria-hidden="true" />
        <span className="wl-system-label">{item.label}</span>
        {item.children && <CaretRight size={13} className="wl-system-chevron" aria-hidden="true" />}
      </button>
    ))
  const drill = compact && selectedGroup
  return createPortal(
    <div
      className="wl-menu-layer"
      ref={root}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div
        ref={main}
        className="wl-system-menu"
        role="menu"
        aria-label={`${title} 时间点菜单`}
        style={placement}
        data-child-left={flipped && !!group}
        data-compact={compact}
        onKeyDown={(event) => keyboard(event, !!drill)}
      >
        <div className="wl-system-heading">
          <div>
            <span className="wl-system-kicker">WORLD LINE / SYSTEM</span>
            <strong>{title}</strong>
            <time>{subtitle}</time>
            <small>{status}</small>
          </div>
          <button
            type="button"
            className="wl-system-close"
            aria-label="关闭时间点菜单"
            onClick={close}
          >
            <X size={14} />
          </button>
        </div>
        {drill ? (
          <>
            <button className="wl-system-back" type="button" onClick={back}>
              <CaretLeft size={14} />
              {selectedGroup.label}
            </button>
            {buttons(selectedGroup.children ?? [], true)}
          </>
        ) : (
          buttons(items)
        )}
        <div className="wl-system-footer">{drill ? '返回上级 · Esc' : '选择操作 · Esc 关闭'}</div>
      </div>
      {selectedGroup && !compact && (
        <div
          ref={child}
          className="wl-system-menu wl-system-submenu"
          role="menu"
          aria-label={`${selectedGroup.label}子菜单`}
          data-flipped={flipped}
          style={subPlacement}
          onKeyDown={(event) => keyboard(event, true)}
        >
          <div className="wl-system-subheading">{selectedGroup.label}</div>
          {buttons(selectedGroup.children ?? [], true)}
        </div>
      )}
    </div>,
    host,
  )
}
