import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown'
import { Check } from '@phosphor-icons/react/dist/csr/Check'
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}
/** Theme-inheriting single select. Focus stays on the trigger while navigating its listbox. */
function Dropdown({
  label,
  value,
  multiple = false,
  placeholder = '选择世界线',
  options,
  onChange,
  disabled = false,
}: {
  label: string
  value: string[]
  multiple?: boolean
  placeholder?: string
  options: SelectOption[]
  onChange(value: string[]): void
  disabled?: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', at: 0 })
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(value[0] ?? '')
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const enabled = options.filter((option) => !option.disabled)
  const show = () => {
    setActive(
      enabled.find((option) => value.includes(option.value))?.value ?? enabled[0]?.value ?? '',
    )
    search.current.text = ''
    setOpen(true)
  }
  const choose = (choice: string) => {
    if (disabled || !enabled.some((option) => option.value === choice)) return
    onChange(
      multiple
        ? value.includes(choice)
          ? value.filter((item) => item !== choice)
          : [...value, choice]
        : [choice],
    )
    if (!multiple) setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const below = window.innerHeight - anchor.bottom - 12
      const above = anchor.top - 12
      const upwards = below < 220 && above > below
      const width = Math.min(Math.max(anchor.width, 200), window.innerWidth - 24)
      setPosition({
        position: 'fixed',
        width,
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
        top: upwards ? undefined : anchor.bottom + 6,
        bottom: upwards ? window.innerHeight - anchor.top + 6 : undefined,
        maxHeight: Math.max(40, Math.min(280, (upwards ? above : below) - 6)),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    return () => window.removeEventListener('scroll', place, true)
  }, [open])
  useEffect(() => {
    if (!open) return
    const container = list.current
    const option = container?.querySelector<HTMLElement>('[data-active=true]')
    if (!container || !option) return
    // Scroll only the list, never its surrounding inspector or the canvas.
    const top = option.offsetTop,
      bottom = top + option.offsetHeight
    if (top < container.scrollTop) container.scrollTop = top
    else if (bottom > container.scrollTop + container.clientHeight)
      container.scrollTop = bottom - container.clientHeight
  }, [open, active])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !list.current?.contains(event.target as Node)
      )
        setOpen(false)
    }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
    }
  }, [open])
  const activeIndex = options.findIndex((option) => option.value === active && !option.disabled)
  return (
    <div className="wl-select">
      <span id={`${id}-label`} className="wl-select-label">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="wl-select-trigger"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            return
          }
          if (event.key === 'Tab') {
            setOpen(false)
            return
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
            event.preventDefault()
            if (!open) {
              show()
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              choose(active)
              return
            }
            const index = enabled.findIndex((option) => option.value === active)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? enabled.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
            if (enabled[next]) setActive(enabled[next].value)
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault()
            if (!open) show()
            const now = Date.now()
            search.current = {
              text:
                (now - search.current.at < 700 ? search.current.text : '') +
                event.key.toLowerCase(),
              at: now,
            }
            const match = enabled.find((option) =>
              option.label.toLowerCase().startsWith(search.current.text),
            )
            if (match) setActive(match.value)
          }
        }}
      >
        <span>
          {options
            .filter((option) => value.includes(option.value))
            .map((option) => option.label)
            .join('、') || placeholder}
        </span>
        <CaretDown size={14} aria-hidden="true" />
      </button>
      {open &&
        trigger.current &&
        createPortal(
          <div
            ref={list}
            id={`${id}-list`}
            className="wl-select-list"
            role="listbox"
            aria-multiselectable={multiple || undefined}
            aria-labelledby={`${id}-label`}
            style={position}
            onPointerDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={value.includes(option.value)}
                aria-disabled={!!option.disabled}
                data-active={option.value === active}
                title={option.label}
                className="wl-select-option"
                onPointerMove={() => {
                  if (!option.disabled) setActive(option.value)
                }}
                onClick={() => choose(option.value)}
              >
                <span>{option.label}</span>
                {value.includes(option.value) && <Check size={15} aria-hidden="true" />}
              </div>
            ))}
          </div>,
          trigger.current.closest('.wl-page') ?? document.body,
        )}
    </div>
  )
}

export function Select(props: {
  label: string
  value: string
  options: SelectOption[]
  onChange(value: string): void
  disabled?: boolean
}) {
  return (
    <Dropdown
      {...props}
      value={[props.value]}
      onChange={(values) => props.onChange(values[0] ?? '')}
    />
  )
}

export function MultiSelect(props: {
  label: string
  value: string[]
  options: SelectOption[]
  onChange(value: string[]): void
  disabled?: boolean
  placeholder?: string
}) {
  return <Dropdown {...props} multiple />
}
