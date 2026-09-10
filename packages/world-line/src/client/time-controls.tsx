import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown'
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise'
import { Crosshair } from '@phosphor-icons/react/dist/csr/Crosshair'
import { SkipBack } from '@phosphor-icons/react/dist/csr/SkipBack'
import { SkipForward } from '@phosphor-icons/react/dist/csr/SkipForward'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { WorldEvent } from '../domain/insight-types.js'
import { adjacentEvent, lineColor } from './timeline-model.js'

const stamp = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
export function TimeControls({
  time,
  start,
  end,
  live,
  events,
  onChange,
  onNow,
}: {
  time: number
  start: number
  end: number
  live: boolean
  events: WorldEvent[]
  onChange(at: number): void
  onNow(): void
}) {
  const [expanded, setExpanded] = useState(false)
  const dock = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!expanded) return
    const dismiss = (event: PointerEvent) => {
      if (!dock.current?.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [expanded])
  const previous = adjacentEvent(events, time, -1)
  const next = adjacentEvent(events, time, 1)
  const percent = (at: number) =>
    Math.max(0, Math.min(100, ((at - start) / Math.max(1, end - start)) * 100))
  return (
    <div
      ref={dock}
      className="wl-time-dock"
      data-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.stopPropagation()
          setExpanded(false)
        }
      }}
    >
      {expanded && (
        <div className="wl-time-scrubber" id="wl-time-scrubber">
          <div className="wl-time-caption">
            <span>沿时间探索</span>
            <span>{events.length} 个记录 · 回看不会隐藏事件</span>
          </div>
          <div
            className="wl-scrub-track"
            style={{ '--wl-progress': `${percent(time)}%` } as CSSProperties}
          >
            <div className="wl-scrub-events" aria-hidden="true">
              {events.map((event) => (
                <i
                  key={event.id}
                  data-kind={event.kind}
                  style={{
                    left: `${percent(Date.parse(event.at))}%`,
                    background: lineColor(event.lineId),
                  }}
                />
              ))}
            </div>
            <input
              type="range"
              aria-label="查看分歧时刻"
              aria-valuetext={stamp(time)}
              min={start}
              max={end}
              step={1}
              value={time}
              onChange={(event) => onChange(Number(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  const direction = event.key === 'ArrowLeft' ? -1 : 1
                  const target = event.shiftKey ? adjacentEvent(events, time, direction) : undefined
                  if (event.shiftKey && !target) return
                  onChange(
                    target
                      ? Date.parse(target.at)
                      : Math.max(start, Math.min(end, time + direction * 60000)),
                  )
                }
              }}
              onPointerUp={(event) => {
                const value = Number(event.currentTarget.value)
                const threshold = ((end - start) * 8) / event.currentTarget.clientWidth
                const nearest = events.reduce<WorldEvent | undefined>(
                  (best, item) =>
                    !best ||
                    Math.abs(Date.parse(item.at) - value) < Math.abs(Date.parse(best.at) - value)
                      ? item
                      : best,
                  undefined,
                )
                if (nearest && Math.abs(Date.parse(nearest.at) - value) <= threshold)
                  onChange(Date.parse(nearest.at))
              }}
            />
          </div>
          <div className="wl-time-caption">
            <time>{stamp(start)}</time>
            <span>← → 分钟 · Shift 跳事件</span>
            <time>{stamp(end)}</time>
          </div>
        </div>
      )}
      <div className="wl-time-transport">
        <button
          className="wl-button wl-icon"
          aria-label="上一个事件"
          title={
            previous
              ? `上一个事件：${previous.title} · ${stamp(Date.parse(previous.at))}`
              : '没有更早的事件'
          }
          disabled={!previous}
          onClick={() => previous && onChange(Date.parse(previous.at))}
        >
          <SkipBack size={16} />
        </button>
        <button
          className="wl-time-display"
          aria-label={expanded ? '收起时间控制器' : '展开时间控制器'}
          aria-expanded={expanded}
          aria-controls="wl-time-scrubber"
          onClick={() => setExpanded(!expanded)}
        >
          <ClockCounterClockwise size={17} />
          <span>
            <small data-live={live}>{live ? '现在' : '回看'}</small>
            <time>{stamp(time)}</time>
          </span>
          <CaretDown size={12} className={expanded ? 'wl-flipped' : ''} />
        </button>
        <button
          className="wl-button wl-icon"
          aria-label="下一个事件"
          title={
            next ? `下一个事件：${next.title} · ${stamp(Date.parse(next.at))}` : '没有更晚的事件'
          }
          disabled={!next}
          onClick={() => next && onChange(Date.parse(next.at))}
        >
          <SkipForward size={16} />
        </button>
        <span className="wl-tool-divider" />
        <button
          className="wl-button wl-icon"
          aria-label="回到现在"
          title="回到现在"
          aria-pressed={live}
          onClick={onNow}
        >
          <Crosshair size={18} />
        </button>
      </div>
    </div>
  )
}
