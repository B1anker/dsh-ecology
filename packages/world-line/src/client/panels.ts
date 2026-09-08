import { type SetStateAction, useRef, useState } from 'react'
import type { InspectorState } from './inspector.js'
export type ToolPanel = {
  section:
    | 'composition'
    | 'compare'
    | 'config'
    | 'report'
    | 'tasks'
    | 'storage'
    | 'recovery'
    | 'research'
  id: string
  lineId?: string
}
type Panel =
  | { kind: 'inspector'; value: InspectorState }
  | { kind: 'merge'; value: string }
  | { kind: 'experiments'; value: string }
  | { kind: 'lab'; value: true }
  | { kind: 'maintenance'; value: true }
  | { kind: 'tools'; value: ToolPanel }
  | null
export function usePanels() {
  const [panel, render] = useState<Panel>(null)
  const current = useRef<Panel>(null)
  const history = useRef<NonNullable<Panel>[]>([])
  const trigger = useRef<HTMLElement | null>(null)
  const sourceLine = useRef<string | null>(null)
  function setPanel(next: Panel) {
    const changed = JSON.stringify(next) !== JSON.stringify(current.current)
    if (next && !current.current) {
      sourceLine.current = next.kind === 'tools' ? (next.value.lineId ?? next.value.id) : null
      const active = document.activeElement as HTMLElement | null
      trigger.current = active?.closest('[role=menu]')
        ? document.querySelector<HTMLElement>('[data-wl-panel-trigger]')
        : active
    }
    if (next && current.current && JSON.stringify(next) !== JSON.stringify(current.current)) {
      history.current.push(current.current)
      if (history.current.length > 30) history.current.shift()
    }
    current.current = next
    render(next)
    if (next && changed)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('.wl-inspector button, .wl-flow button')?.focus(),
      )
    if (!next) {
      history.current = []
      requestAnimationFrame(() => {
        if (trigger.current?.isConnected) trigger.current.focus()
        else {
          const source = sourceLine.current
            ? document.querySelector<HTMLElement>(
                `.react-flow__node[data-id="${CSS.escape(sourceLine.current)}"] button`,
              )
            : null
          ;(
            source ?? document.querySelector<HTMLElement>('.wl-page button:not([disabled])')
          )?.focus()
        }
      })
    }
  }
  function setter<T>(kind: NonNullable<Panel>['kind'], empty: T) {
    return (next: SetStateAction<T>) => {
      const previous = current.current
      const old = (previous?.kind === kind ? previous.value : empty) as T
      const value = typeof next === 'function' ? (next as (old: T) => T)(old) : next
      if (value === null || value === false) {
        if (previous?.kind === kind) setPanel(null)
      } else setPanel({ kind, value } as Panel)
    }
  }
  return {
    canGoBack: history.current.length > 0,
    goBack: () => {
      const previous = history.current.pop()
      if (previous) {
        current.current = previous
        render(previous)
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('.wl-inspector button, .wl-flow button')?.focus(),
        )
      } else setPanel(null)
    },
    inspector: panel?.kind === 'inspector' ? panel.value : null,
    setInspector: setter<InspectorState | null>('inspector', null),
    mergeId: panel?.kind === 'merge' ? panel.value : null,
    setMergeId: setter<string | null>('merge', null),
    experimentSource: panel?.kind === 'experiments' ? panel.value : null,
    setExperimentSource: setter<string | null>('experiments', null),
    labFlowOpen: panel?.kind === 'lab',
    setLabFlowOpen: setter<boolean>('lab', false),
    maintenanceOpen: panel?.kind === 'maintenance',
    setMaintenanceOpen: setter<boolean>('maintenance', false),
    toolPanel: panel?.kind === 'tools' ? panel.value : null,
    setToolPanel: setter<ToolPanel | null>('tools', null),
  }
}
