import type { CSSProperties } from 'react'

/** Shared entrance contract: staggered stacking with vertical stretch, never a list-level slide.
 * Main menus and submenus use the same motion. Canvas tools only mirror direction/order.
 * Keep incoming rows in one clipped list, not individual clipped slots: the stack must be visible.
 */
export const menuMotion = {
  lead: 40,
  gap: 80,
  duration: 440,
  rowHeight: 42,
  swapExit: 240,
  followGap: 60,
  chrome: 240,
  close: 220,
  closeGap: 14,
} as const

export function menuItemMotion(index: number, count: number, reverse = false): CSSProperties {
  const order = reverse ? count - 1 - index : index
  return {
    '--wl-item-index': order,
    '--wl-exit-index': Math.min(7, count - 1 - order),
    '--wl-stack-offset': `${(reverse ? -1 : 1) * (count - order) * menuMotion.rowHeight}px`,
    '--wl-item-origin': reverse ? 'center top' : 'center bottom',
  } as CSSProperties
}

export const menuDismissDuration = menuMotion.close + 7 * menuMotion.closeGap + 20

export function menuLastExitStart(count: number): number {
  return menuMotion.lead + Math.max(0, count - 1) * menuMotion.gap
}

/** Leave a short gap after the outgoing tail starts moving before the incoming stack follows. */
export function menuFollowLastExit(count: number): CSSProperties {
  const start = menuLastExitStart(count) + menuMotion.followGap
  return {
    '--wl-item-lead': `${start}ms`,
    '--wl-stack-reveal-delay': `${start}ms`,
  } as CSSProperties
}

export function menuSwapExitDuration(count: number): number {
  return menuLastExitStart(count) + menuMotion.swapExit
}

export const menuEntranceStyles = `
@media(prefers-reduced-motion:no-preference){
.wl-system-menu{--wl-item-gap:${menuMotion.gap}ms;--wl-item-lead:${menuMotion.lead}ms;--wl-item-duration:${menuMotion.duration}ms;--wl-swap-exit:${menuMotion.swapExit}ms;--wl-menu-chrome:${menuMotion.chrome}ms;--wl-close-duration:${menuMotion.close}ms;--wl-close-gap:${menuMotion.closeGap}ms;--wl-item-ease:cubic-bezier(.2,.7,.25,1);animation:none}
.wl-system-item{transform-origin:var(--wl-item-origin,center bottom);animation:wl-system-elastic var(--wl-item-duration) var(--wl-item-ease) backwards;animation-delay:calc(var(--wl-item-lead) + var(--wl-item-index,0) * var(--wl-item-gap))}
.wl-system-items[data-follow-exit=true]{animation:wl-menu-stack-reveal 0s linear backwards;animation-delay:var(--wl-stack-reveal-delay)}
@keyframes wl-menu-stack-reveal{from{visibility:hidden}to{visibility:visible}}
@keyframes wl-system-elastic{from{transform:translateY(var(--wl-stack-offset,84px)) scale(.97,1.12)}to{transform:translateY(0) scale(1)}}
}
`
