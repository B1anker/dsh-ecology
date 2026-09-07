import { ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight'
import { X } from '@phosphor-icons/react/dist/csr/X'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EntryTransition } from './entry-transition.js'

type Phase = 'linking' | 'warping' | 'ready' | 'error'
interface EntryView {
  alias: string
  id: string
  phase: Phase
  document: Document
  popup: Window | null
  error?: string
  url?: string
  skipped: boolean
}
const entryStyles = `
.wl-dive{--dive-accent:var(--dsw-alias-state-business-primary);position:fixed;inset:0;z-index:2147483000;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;isolation:isolate}
.wl-dive *{box-sizing:border-box}.wl-dive canvas{position:absolute;inset:0;width:100%;height:100%;z-index:-1}.wl-dive-horizon{position:absolute;width:min(30vw,360px);aspect-ratio:1;top:44%;left:50%;translate:-50% -50%;background:radial-gradient(circle,color-mix(in srgb,var(--dive-accent) 12%,transparent),transparent 70%);pointer-events:none}
.wl-dive-top{position:absolute;inset:28px 32px auto;display:flex;justify-content:space-between;align-items:center;gap:24px}.wl-dive-brand{font-size:11px;letter-spacing:.24em;color:var(--dsw-alias-label-secondary)}.wl-dive-top button,.wl-dive-return,.wl-dive-link{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;text-decoration:none}.wl-dive button:hover,.wl-dive-link:hover{background:var(--dsw-alias-bg-module-platform)}.wl-dive button:focus-visible,.wl-dive a:focus-visible{outline:2px solid var(--dive-accent);outline-offset:4px}
.wl-dive-center{position:relative;text-align:center;max-width:min(560px,calc(100vw - 48px));margin-top:-6vh}.wl-dive-kicker{font-size:11px;letter-spacing:.4em;color:var(--dive-accent);margin:0 0 16px}.wl-dive h1{font-weight:300;font-size:clamp(28px,5.5vw,68px);letter-spacing:.18em;margin:0;text-indent:.18em}.wl-dive-target{margin:28px 0 0;display:inline-grid;gap:6px;padding:12px 24px;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,transparent)}.wl-dive-target strong{font-size:20px;font-weight:500;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dive-accent)}.wl-dive-target small{font-size:10px;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.wl-dive-status{margin:22px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}.wl-dive-bottom{position:absolute;bottom:32px;left:24px;right:24px;text-align:center;display:grid;justify-items:center;gap:14px}.wl-dive-steps{display:flex;gap:24px;align-items:center;font-size:10px;letter-spacing:.16em;color:var(--dsw-alias-label-tertiary)}.wl-dive-steps span[data-active=true]{color:var(--dive-accent)}.wl-dive-cancel{font:inherit;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:8px}.wl-dive-error{max-width:460px;margin:20px auto;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.wl-dive-link{margin:18px auto 0;color:var(--dive-accent)}
@media(prefers-reduced-motion:no-preference){.wl-dive-center{animation:wl-dive-lock .6s ease-out both}.wl-dive[data-phase=warping] .wl-dive-center{animation:wl-dive-away 1.25s cubic-bezier(.4,0,.9,1) both}.wl-dive[data-phase=warping] .wl-dive-horizon{animation:wl-dive-aperture 1.25s ease-in both}.wl-dive[data-phase=linking] .wl-dive-kicker{animation:wl-dive-pulse 2.8s ease-in-out infinite}@keyframes wl-dive-lock{from{opacity:0;transform:scale(.92);filter:blur(4px)}to{opacity:1;transform:scale(1);filter:blur(0)}}@keyframes wl-dive-away{0%,20%{opacity:1;transform:scale(1);filter:blur(0)}100%{opacity:0;transform:scale(2.4);filter:blur(9px)}}@keyframes wl-dive-aperture{to{transform:scale(8);opacity:.35}}@keyframes wl-dive-pulse{50%{opacity:.5}}}
.wl-dive[data-skipped=true] *{animation:none!important}.wl-dive[data-paused=true] *{animation-play-state:paused!important}
@media(max-width:600px){.wl-dive-top{inset:18px 18px auto;gap:12px}.wl-dive-brand{font-size:9px;letter-spacing:.12em}.wl-dive-top button{font-size:11px;padding:7px 9px}.wl-dive-target{padding:12px 16px}.wl-dive-target strong{font-size:18px}.wl-dive-steps{gap:12px;font-size:9px}.wl-dive-status{font-size:12px}.wl-dive-bottom{bottom:20px}}
`

function Dive({ view, skip, cancel }: { view: EntryView; skip(): void; cancel(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const phase = useRef(view.phase)
  phase.current = view.phase
  useEffect(() => {
    const doc = view.document
    const win = doc.defaultView!
    const root = panel.current!
    root.querySelector<HTMLElement>('button')?.focus()
    // Portals still bubble through their source tree; keep entry keyboard input local.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        cancel()
      }
      if (event.key === 'Tab') {
        const controls = Array.from(root.querySelectorAll<HTMLElement>('button,a'))
        const index = controls.indexOf(doc.activeElement as HTMLElement)
        event.preventDefault()
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
      }
    }
    doc.addEventListener('keydown', key, true)
    const el = canvas.current!
    const ctx = el.getContext('2d')
    if (!ctx) return () => doc.removeEventListener('keydown', key, true)
    const media = win.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0,
      width = 0,
      height = 0,
      elapsed = 0,
      last = 0,
      warpStarted = 0
    const css = getComputedStyle(root)
    const accent = css.getPropertyValue('--dsw-alias-state-business-primary').trim()
    const neutral = css.getPropertyValue('--dsw-alias-label-tertiary').trim()
    const resize = () => {
      width = root.clientWidth
      height = root.clientHeight
      const dpr = Math.min(win.devicePixelRatio || 1, 2)
      el.width = width * dpr
      el.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2,
        cy = height * 0.44
      const radius = Math.min(width, height) * 0.18
      const warping = phase.current === 'warping'
      if (warping && !warpStarted) warpStarted = elapsed
      const speed = warping ? 1 + Math.min(1, (elapsed - warpStarted) / 900) * 8 : 1
      const travel =
        elapsed * 0.000055 + (warping ? Math.pow((elapsed - warpStarted) / 1000, 2) * 0.6 : 0)
      ctx.lineWidth = 1
      // Project rings and longitudinal rays through a vanishing point. Positions
      // are deterministic; motion is elapsed-time based and never uses React frames.
      for (let ring = 0; ring < 13; ring++) {
        const depth = (ring / 13 + travel) % 1
        const r = radius * (0.25 + depth * depth * 6)
        ctx.strokeStyle = ring % 3 ? neutral : accent
        ctx.globalAlpha = Math.sin(depth * Math.PI) * (warping ? 0.21 : 0.12)
        ctx.beginPath()
        ctx.ellipse(cx, cy, r, r * 0.8, 0, 0, Math.PI * 2)
        ctx.stroke()
      }
      for (let i = 0; i < 100; i++) {
        const angle = i * 2.399963 + Math.sin(i * 9.1) * 0.12
        const depth = (i * 0.618034 + travel * (1 + (i % 5) * 0.09)) % 1
        const near = radius * (0.65 + depth * depth * 9)
        const length = (6 + depth * depth * 55) * speed
        const x = Math.cos(angle),
          y = Math.sin(angle) * 0.8
        ctx.strokeStyle = i % 4 ? accent : neutral
        ctx.globalAlpha = Math.sin(depth * Math.PI) * (warping ? 0.55 : 0.23)
        ctx.lineWidth = i % 11 === 0 ? 1.5 : 0.7
        ctx.beginPath()
        ctx.moveTo(cx + x * near, cy + y * near)
        ctx.lineTo(cx + x * (near + length), cy + y * (near + length))
        ctx.stroke()
      }
      // Quiet orbital arcs frame the target during the connection stage.
      ctx.strokeStyle = accent
      ctx.lineWidth = 1
      ctx.globalAlpha = warping ? 0.06 : 0.28
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2 + elapsed * 0.00004
        ctx.beginPath()
        ctx.arc(cx, cy, radius * 1.45, angle, angle + 0.8)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    const tick = (now: number) => {
      const dt = last ? Math.min(40, now - last) : 0
      last = now
      elapsed += dt
      draw()
      frame = win.requestAnimationFrame(tick)
    }
    const sync = () => {
      win.cancelAnimationFrame(frame)
      last = 0
      root.dataset.paused = String(doc.hidden)
      if (
        !doc.hidden &&
        !media.matches &&
        !view.skipped &&
        !['ready', 'error'].includes(phase.current)
      )
        frame = win.requestAnimationFrame(tick)
      else draw()
    }
    resize()
    sync()
    const observer = new ResizeObserver(() => {
      resize()
      if (media.matches || view.skipped) draw()
    })
    observer.observe(root)
    doc.addEventListener('visibilitychange', sync)
    media.addEventListener('change', sync)
    return () => {
      observer.disconnect()
      win.cancelAnimationFrame(frame)
      doc.removeEventListener('keydown', key, true)
      doc.removeEventListener('visibilitychange', sync)
      media.removeEventListener('change', sync)
    }
  }, [view.document, view.skipped, view.phase === 'error', view.phase === 'ready'])
  return (
    <div
      ref={panel}
      className="wl-dive"
      data-phase={view.phase}
      data-skipped={view.skipped}
      role="dialog"
      aria-modal="true"
      aria-label={`进入世界线 ${view.alias}`}
    >
      <style>{entryStyles}</style>
      <canvas ref={canvas} aria-hidden="true" />
      <div className="wl-dive-horizon" />
      <div className="wl-dive-top">
        <span className="wl-dive-brand">WORLD LINE / DIVE</span>
        {!['ready', 'error'].includes(view.phase) && (
          <button onClick={skip}>
            {view.skipped ? '等待通路就绪' : '跳过动画'}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
      <div className="wl-dive-center">
        <p className="wl-dive-kicker">
          {view.phase === 'error'
            ? 'CONNECTION INTERRUPTED'
            : view.phase === 'ready'
              ? 'LINK READY'
              : 'LINK START'}
        </p>
        <h1>
          {view.phase === 'error'
            ? '通路未建立'
            : view.phase === 'ready'
              ? '世界线已就绪'
              : view.phase === 'warping'
                ? '正在潜行'
                : '连接世界线'}
        </h1>
        <div className="wl-dive-target">
          <strong>{view.alias}</strong>
          <small>{view.id}</small>
        </div>
        <p className="wl-dive-status" role="status">
          {view.phase === 'linking'
            ? '正在唤醒目标实例，校准进入通路…'
            : view.phase === 'warping'
              ? '通路已建立 · 正在进入目标世界线'
              : view.phase === 'ready'
                ? '点击下方按钮，在新标签页进入。'
                : ''}
        </p>
        {view.error && (
          <p className="wl-dive-error" role="alert">
            {view.error}
          </p>
        )}
        {view.url && (
          <a
            className="wl-dive-link"
            href={view.url}
            target="_blank"
            rel="noreferrer"
            onClick={cancel}
          >
            进入 {view.alias}
            <ArrowRight size={16} />
          </a>
        )}
        {view.phase === 'error' && (
          <button className="wl-dive-return" onClick={cancel}>
            返回世界线图谱
          </button>
        )}
      </div>
      <div className="wl-dive-bottom">
        <div className="wl-dive-steps">
          <span data-active={view.phase === 'linking'}>01 / 定位</span>
          <span data-active={view.phase !== 'linking' && view.phase !== 'error'}>02 / 通路</span>
          <span data-active={view.phase === 'warping'}>03 / 潜行</span>
        </div>
        <button className="wl-dive-cancel" onClick={cancel}>
          <X size={12} />{' '}
          {view.phase === 'error' || view.phase === 'ready' ? '返回图谱' : '取消进入'}
        </button>
      </div>
    </div>
  )
}

export function useWorldLineEntry() {
  const [view, setView] = useState<EntryView | null>(null)
  const active = useRef<{
    transition: EntryTransition
    popup: Window | null
    watch: number
  } | null>(null)
  const cancel = () => {
    const session = active.current
    if (session) {
      session.transition.cancel()
      clearInterval(session.watch)
      session.popup?.close()
    }
    active.current = null
    setView(null)
  }
  useEffect(
    () => () => {
      const session = active.current
      session?.transition.cancel()
      if (session) {
        clearInterval(session.watch)
        session.popup?.close()
      }
    },
    [],
  )
  const begin = (alias: string, id: string, source: HTMLElement) => {
    cancel()
    const popup = window.open('about:blank', '_blank')
    const doc = popup?.document ?? document
    if (popup) {
      popup.opener = null
      doc.title = `进入 ${alias} · World Line`
      const css = getComputedStyle(source)
      for (let i = 0; i < css.length; i++) {
        const name = css.item(i)
        if (name.startsWith('--dsw-alias-'))
          doc.documentElement.style.setProperty(name, css.getPropertyValue(name))
      }
      doc.documentElement.lang = 'zh-CN'
      doc.body.style.margin = '0'
      doc.body.style.background = css.getPropertyValue('--dsw-alias-bg-base')
      const viewport = doc.createElement('meta')
      viewport.name = 'viewport'
      viewport.content = 'width=device-width,initial-scale=1'
      doc.head.append(viewport)
    }
    const reduced = (doc.defaultView ?? window).matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    const transition = new EntryTransition({
      holdMs: reduced ? 0 : 800,
      warpMs: reduced ? 0 : 1250,
      warp: () => setView((value) => value && { ...value, phase: 'warping' }),
      navigate: (url) => {
        const session = active.current
        if (!session || session.transition !== transition) return
        clearInterval(session.watch)
        if (popup && !popup.closed) {
          active.current = null
          setView(null)
          popup.location.replace(url)
        } else if (!popup) setView((value) => value && { ...value, phase: 'ready', url })
        else cancel()
      },
    })
    const watch = popup
      ? window.setInterval(() => {
          if (popup.closed) cancel()
        }, 250)
      : 0
    active.current = { transition, popup, watch }
    setView({ alias, id, phase: 'linking', document: doc, popup, skipped: reduced })
    return {
      finish: (url: string) => transition.finish(url),
      fail: (error: string) => {
        if (active.current?.transition !== transition) return
        transition.cancel()
        setView((value) => value && { ...value, phase: 'error', error })
      },
    }
  }
  const skip = () => {
    active.current?.transition.skip()
    setView((value) => value && { ...value, skipped: true })
  }
  return {
    begin,
    entry: view
      ? createPortal(<Dive view={view} skip={skip} cancel={cancel} />, view.document.body)
      : null,
  }
}
