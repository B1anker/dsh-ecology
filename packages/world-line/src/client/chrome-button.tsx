import type { ComponentPropsWithoutRef } from 'react'

/** Shared glass and diamond treatment for panel navigation controls. */
export function ChromeButton({ className = '', ...props }: ComponentPropsWithoutRef<'button'>) {
  return <button type="button" {...props} className={`wl-chrome-button ${className}`} />
}
