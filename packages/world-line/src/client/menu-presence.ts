import { useCallback, useEffect, useRef, useState } from 'react'
import { menuDismissDuration } from './menu-motion.js'

/** Keep menus mounted through their reverse exit; repeated dismissals never restart it. */
export function useMenuPresence<T>() {
  const [value, setValue] = useState<T | null>(null)
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const update = useCallback((next: T | null) => {
    if (next !== null) {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
      setClosing(false)
      setValue(next)
      return
    }
    if (timer.current !== null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(null)
      setClosing(false)
      return
    }
    setClosing(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setValue(null)
      setClosing(false)
    }, menuDismissDuration)
  }, [])
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return [value, update, closing] as const
}

/** Floating menus own Escape even when pointer activation leaves focus on their trigger. */
export function useMenuEscape(close: () => void, active = true) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [active])
}
