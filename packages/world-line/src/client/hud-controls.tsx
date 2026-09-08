import { Children, isValidElement, type ReactNode } from 'react'
import { Select } from './select.js'
/** Share the same HUD selector across snapshot, storage and workflow panels. */
export function HudSelect({
  value,
  onChange,
  children,
  disabled,
  ...props
}: {
  value?: string
  onChange(e: { target: { value: string } }): void
  children: ReactNode
  disabled?: boolean
  'aria-label'?: string
}) {
  const text = (node: ReactNode): string =>
    Children.toArray(node)
      .map((n) =>
        isValidElement<{ children?: ReactNode }>(n) ? text(n.props.children) : String(n),
      )
      .join('')
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((node: any) => ({
      value: String(node.props.value ?? ''),
      label: text(node.props.children),
      disabled: !!node.props.disabled,
    }))
  return (
    <div className="wl-hud-select-field">
      <Select
        label={props['aria-label'] ?? '选择记录'}
        value={value ?? ''}
        options={options}
        disabled={disabled}
        onChange={(value) => onChange({ target: { value } })}
      />
    </div>
  )
}
export function HudTabs({
  value,
  onChange,
  items,
  label,
}: {
  value: string
  onChange(value: string): void
  items: { id: string; title: string }[]
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="wl-hud-tabs">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          tabIndex={value === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault()
              const n =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? items.length - 1
                    : (i + (e.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length
              onChange(items[n]!.id)
              ;(e.currentTarget.parentElement?.children[n] as HTMLElement)?.focus()
            }
          }}
        >
          {item.title}
        </button>
      ))}
    </div>
  )
}
