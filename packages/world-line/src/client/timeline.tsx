import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight'
import { ArrowsLeftRight } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
import { Camera } from '@phosphor-icons/react/dist/csr/Camera'
import { Circle } from '@phosphor-icons/react/dist/csr/Circle'
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise'
import { CornersOut } from '@phosphor-icons/react/dist/csr/CornersOut'
import { DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree'
import { FileText } from '@phosphor-icons/react/dist/csr/FileText'
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch'
import { GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge'
import { Minus } from '@phosphor-icons/react/dist/csr/Minus'
import { PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple'
import { Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { SlidersHorizontal } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
import { Star } from '@phosphor-icons/react/dist/csr/Star'
import { Stop } from '@phosphor-icons/react/dist/csr/Stop'
import { Trash } from '@phosphor-icons/react/dist/csr/Trash'
import { UploadSimple } from '@phosphor-icons/react/dist/csr/UploadSimple'
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  Handle,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useUpdateNodeInternals,
  ViewportPortal,
} from '@xyflow/react'
import {
  type CSSProperties,
  type MouseEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { WorldEvent } from '../domain/insight-types.js'
import { ContextMenu, type MenuAction } from './context-menu.js'
import { menuItemMotion } from './menu-motion.js'
import { useMenuEscape, useMenuPresence } from './menu-presence.js'
import {
  canvasConnections,
  clusterZoom,
  eventMarkers,
  type Line,
  label,
  lineColor,
  mergeConnectionPath,
  ROW_HEIGHT,
  restoreRelation,
  stateLabel,
  TRACK_LEFT,
  timelineScale,
} from './timeline-model.js'
import { TooltipButton } from './tooltip-button.js'

export { type Line, label, stateLabel } from './timeline-model.js'

type TrackData = {
  line: Line
  missingParent: boolean
  experiments: Line[]
  showExperiments(): void
  width: number
  time: number
  cursorX: number | null
  forks: { id: string; x: number }[]
  active: boolean
  busy: boolean
  dissolving: boolean
  compared: boolean
  markers: { x: number; events: WorldEvent[] }[]
  expandedIds: string[]
  focusedEventId?: string
  menuOpen: boolean
  restoration:
    | (NonNullable<ReturnType<typeof restoreRelation>> & { fromX: number; toX: number })
    | null
  enter(): void
  inspect(events: WorldEvent[]): void
  openEvent(mouse: MouseEvent<HTMLElement>, event: WorldEvent): void
  open(event: MouseEvent<HTMLElement>, line: Line): void
}
type Track = Node<TrackData, 'worldline'>
type Branch = Edge<
  { active: boolean; color: string; stopped: boolean; missingParent: boolean },
  'branch'
>
function TrackNode({ id, data }: NodeProps<Track>) {
  const arrowId = useId()
  const update = useUpdateNodeInternals()
  const handles = data.forks.map((fork) => `${fork.id}:${fork.x}`).join(',')
  useEffect(() => {
    update(id)
  }, [id, handles, update])
  const line = data.line
  return (
    <div
      className="wl-flow-track"
      data-active={data.active}
      data-compared={data.compared}
      data-dissolving={data.dissolving}
      data-running={line.state === 'running'}
      data-stopped={line.state === 'stopped'}
      style={{ width: data.width + 220, '--wl-line-color': lineColor(line.id) } as CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ top: 36, left: 0 }}
      />
      {data.forks.map((fork) => (
        <Handle
          key={fork.id}
          id={fork.id}
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          style={{ top: 36, left: fork.x }}
        />
      ))}
      <div className="wl-flow-rail" style={{ width: data.width }}>
        <span className="wl-birth" />
        {data.markers.map((marker) => {
          const event =
            marker.events.findLast((item) => item.kind === 'snapshot') ?? marker.events.at(-1)!
          const grouped = marker.events.length > 1
          const expandedIndex = grouped ? -1 : data.expandedIds.indexOf(event.id)
          const eventNames = marker.events.map((item) => item.title).join('；')
          return (
            <TooltipButton
              key={event.id}
              className="wl-event-marker nodrag nopan"
              data-event-id={event.id}
              data-kind={event.kind}
              data-expanded={expandedIndex >= 0}
              data-restored-history={
                !!data.restoration &&
                marker.events.every(
                  (item) =>
                    item.id !== data.restoration!.restore.id &&
                    Date.parse(item.at) > Date.parse(data.restoration!.target.at) &&
                    Date.parse(item.at) < Date.parse(data.restoration!.restore.at),
                )
              }
              data-ahead={marker.events.every((item) => Date.parse(item.at) > data.time)}
              data-at-cursor={marker.events.some((item) =>
                data.focusedEventId
                  ? item.id === data.focusedEventId
                  : Date.parse(item.at) === data.time,
              )}
              style={{ left: marker.x }}
              tooltipTitle={
                grouped
                  ? `${marker.events.length} 个事件`
                  : event.actionLabel
                    ? `${event.actionLabel} · ${event.statusLabel}`
                    : event.title
              }
              tooltipDescription={
                grouped ? (
                  <>
                    <p>
                      {timestamp(Date.parse(marker.events[0]!.at))} –{' '}
                      {timestamp(Date.parse(marker.events.at(-1)!.at))}
                    </p>
                    {marker.events.slice(0, 4).map((item) => (
                      <p key={item.id}>{item.title}</p>
                    ))}
                  </>
                ) : (
                  <>
                    {event.packages
                      ? event.packages.map((pkg) => (
                          <p key={pkg.name}>
                            {pkg.name} · {pkg.version}
                          </p>
                        ))
                      : event.packageLabel && <p>{event.packageLabel}</p>}
                    <p>{timestamp(Date.parse(event.at))}</p>
                  </>
                )
              }
              tooltipAction={
                grouped
                  ? marker.events.every((item) => item.at === event.at)
                    ? '查看历史记录'
                    : '放大展开'
                  : '查看详情'
              }
              tooltipColor={lineColor(line.id)}
              aria-label={
                grouped
                  ? `${label(line)} 此处有 ${marker.events.length} 条记录：${eventNames}`
                  : `${label(line)} ${event.title}`
              }
              disabled={data.busy}
              onClick={(mouse) => {
                mouse.stopPropagation()
                data.inspect(marker.events)
              }}
              onContextMenu={(mouse) => {
                mouse.stopPropagation()
                if (grouped) data.inspect(marker.events)
                else data.openEvent(mouse, event)
              }}
            >
              {grouped ? (
                marker.events.length
              ) : event.kind === 'snapshot' ? (
                '◆'
              ) : event.kind === 'restore' ? (
                <ArrowCounterClockwise size={14} weight="regular" />
              ) : event.kind === 'merge' ? (
                <GitMerge size={16} weight="regular" />
              ) : (
                '○'
              )}
            </TooltipButton>
          )
        })}
        {data.restoration && (
          <svg
            className="wl-restore-link"
            style={{ width: data.width }}
            aria-label={`恢复指向 ${timestamp(Date.parse(data.restoration.target.at))} 的快照`}
          >
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 1 1 L 7 4 L 1 7" />
              </marker>
            </defs>
            <path
              markerEnd={`url(#${arrowId})`}
              d={`M ${data.restoration.fromX} 17 C ${data.restoration.fromX} 43, ${data.restoration.toX + 50} 43, ${data.restoration.toX + 18} 18`}
            />
          </svg>
        )}
        {line.state === 'running' && <span className="wl-flow-energy" />}
        {data.cursorX !== null && (
          <span
            className="wl-time-point"
            data-expanded-overlap={data.markers.some(
              (marker) =>
                Math.abs(marker.x - data.cursorX!) < 20 &&
                marker.events.some((event) => data.expandedIds.includes(event.id)),
            )}
            data-overlap={data.markers.some((marker) => Math.abs(marker.x - data.cursorX!) < 20)}
            style={{ left: data.cursorX }}
          />
        )}
        <span className="wl-flow-date">
          {line.kind === 'origin' ? '来源' : line.parentId ? '分支' : '创建'} ·{' '}
          {new Date(line.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="wl-flow-label" style={{ left: data.width + 18 }}>
        <div className="wl-row-title">
          <strong title={label(line)}>{label(line)}</strong>
          {line.isDefault && <span className="wl-badge">默认</span>}
          {data.compared && <span className="wl-badge">对比</span>}
        </div>
        <span className="wl-status" data-running={line.state === 'running'}>
          <Circle
            size={7}
            weight="fill"
            className={line.state === 'running' ? 'wl-live-dot' : ''}
          />
          {stateLabel(line.state)}
          {line.initialization === 'clean' ? ' · 从干净环境创建' : ''}
          {line.port ? ` · ${line.port}` : ''}
        </span>
        <span className="wl-muted">
          {line.kind === 'origin'
            ? '正式环境'
            : line.verdict === 'passed'
              ? '验证通过'
              : line.verdict === 'review'
                ? '异常待确认'
                : line.verdict === 'awaiting_auth'
                  ? '等待登录'
                  : line.verdict === 'incomplete'
                    ? '基础检查完成'
                    : line.verdict === 'failed'
                      ? '验证失败'
                      : '未校验'}
        </span>
        {data.missingParent && (
          <span
            className="wl-muted"
            style={{ display: 'block', whiteSpace: 'nowrap', fontSize: 10 }}
            title={`原来源：${line.parentId}。虚线仅连接画布主干，不改变实际来源。`}
          >
            来源缺失 · 虚线连接主干
          </span>
        )}
      </div>
      <button
        className="wl-button wl-icon wl-point-action nodrag nopan"
        aria-label={`${label(line)} 时间点操作`}
        title={`${label(line)} 时间点操作`}
        data-wl-menu-toggle
        aria-expanded={data.menuOpen}
        onPointerDown={(event) => event.stopPropagation()}
        aria-haspopup="menu"
        disabled={data.busy}
        onClick={(event) => {
          event.stopPropagation()
          data.open(event, line)
        }}
      >
        <DotsThree size={20} />
      </button>
      {data.dissolving && (
        <span className="wl-disintegration" aria-hidden="true">
          {Array.from({ length: 14 }, (_, index) => (
            <i key={index} />
          ))}
        </span>
      )}
    </div>
  )
}
function BranchEdge({ sourceX, sourceY, targetX, targetY, data, ...props }: EdgeProps<Branch>) {
  // Leave and join the horizontal tracks tangentially instead of a vertical T junction.
  const bend = Math.max(18, Math.min(36, Math.abs(targetY - sourceY) / 3))
  const path = `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`
  return (
    <BaseEdge
      {...props}
      path={path}
      interactionWidth={24}
      style={{
        stroke: data?.color,
        strokeDasharray: data?.stopped || data?.missingParent ? '6 4' : undefined,
        opacity: data?.active ? 1 : 0.7,
        strokeWidth: data?.active ? 2 : 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }}
    />
  )
}
const fitOptions: FitViewOptions<Track> = {
  padding: { top: '110px', bottom: '120px', left: '40px', right: '40px' },
  maxZoom: 1,
}
const nodeTypes = { worldline: TrackNode }
const edgeTypes = { branch: BranchEdge }
const timestamp = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

export function Timeline({
  lines,
  experiments,
  onExperiments,
  onInstall,
  onComposition,
  selected,
  onSelect,
  onFork,
  onEnter,
  onTimeChange,
  onManage,
  events,
  comparisonIds,
  onCompare,
  onEvent,
  eventFocus,
  onHistory,
  onSnapshot,
  onPromote,
  onVerify,
  onReport,
  onMerge,
  mergeAvailable,
  currentId,
  time,
  start,
  end,
  busy = false,
  dissolvingId = null,
}: {
  lines: Line[]
  experiments: Line[]
  onExperiments(id: string): void
  onInstall(id: string): void
  onComposition(id: string): void
  selected: string
  events: WorldEvent[]
  comparisonIds: string[]
  onCompare(id: string): void
  onEvent(event: WorldEvent): void
  eventFocus: { id: string; revision: number } | null
  onHistory(id: string): void
  onSnapshot(id: string): void
  onPromote(id: string): void
  onVerify(id: string, interactive: boolean): void
  onReport(id: string): void
  onMerge(id: string): void
  mergeAvailable: boolean
  onSelect(id: string): void
  onFork(id: string, at?: number, snapshotId?: string, clean?: boolean): void
  onEnter(id: string): void
  onTimeChange(at: number): void
  onManage(action: 'restart' | 'start' | 'default' | 'alias' | 'stop' | 'destroy', id: string): void
  currentId: string | null
  time: number
  start: number
  end: number
  busy?: boolean
  dissolvingId?: string | null
}) {
  const [expanded, setExpanded] = useState<WorldEvent[]>([])
  const [markerZoom, setMarkerZoom] = useState(1)
  // Reserve spacing on the shared time axis for every independently visible marker.
  // Per-row nudges can otherwise put an earlier source to the right of its merge.
  const separatedIds = useMemo(() => {
    const ids = new Set(expanded.map((event) => event.id))
    if (eventFocus) ids.add(eventFocus.id)
    for (const event of events) if (event.kind === 'merge') ids.add(event.id)
    for (const line of lines) {
      const relation = restoreRelation(events, line.id)
      if (relation) {
        ids.add(relation.restore.id)
        ids.add(relation.target.id)
      }
    }
    return [...ids]
  }, [expanded, eventFocus, events, lines])
  const scale = useMemo(
    () =>
      timelineScale(
        start,
        end,
        [
          ...events.map((event) => Date.parse(event.at)),
          ...lines.flatMap((line) => [
            Date.parse(line.createdAt),
            Date.parse(line.forkedAt ?? line.createdAt),
          ]),
        ],
        events
          .filter((event) => separatedIds.includes(event.id))
          .map((event) => Date.parse(event.at)),
      ),
    [start, end, events, lines, separatedIds],
  )
  const timeX = scale.toX
  const pointTime = (x: number, line: Line) => Math.max(Date.parse(line.createdAt), scale.toTime(x))
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactFlowInstance<Track, Branch> | null>(null)
  const resetView = useRef(false)
  const beforeExpandZoom = useRef<number | null>(null)
  const collapseZoom = useRef<number | null>(null)
  const focusEvent = events.find(
    (event) =>
      event.id === eventFocus?.id && event.lineId === selected && Date.parse(event.at) === time,
  )
  useEffect(() => {
    if (!focusEvent) return
    if (expanded.length && !expanded.some((event) => event.id === focusEvent.id)) {
      collapseZoom.current = beforeExpandZoom.current
      beforeExpandZoom.current = null
      setExpanded([])
      return
    }
    const line = lines.find((line) => line.id === focusEvent.lineId)
    if (!line) return
    const cluster = eventMarkers(
      events,
      line,
      start,
      end,
      scale.toX,
      [focusEvent.id],
      markerZoom,
    ).find((marker) => marker.events.some((event) => event.id === focusEvent.id))
    if (cluster && cluster.events.length > 1) {
      if (!expanded.length) beforeExpandZoom.current = instance.current?.getZoom() ?? 1
      setExpanded(cluster.events)
    }
  }, [eventFocus])
  useEffect(() => {
    if (!expanded.length) {
      if (resetView.current) {
        resetView.current = false
        void instance.current?.fitView(fitOptions)
      }
      return
    }
    const row = lines.findIndex((line) => line.id === expanded[0]!.lineId)
    const positions = expanded.map((event) => scale.toX(Date.parse(event.at)))
    void instance.current?.setCenter(
      (Math.min(...positions) + Math.max(...positions)) / 2,
      126 + Math.max(0, row) * ROW_HEIGHT,
      { zoom: 1.5, duration: 300 },
    )
  }, [expanded])
  const [menu, setMenu, menuClosing] = useMenuPresence<{
    id: string
    at: number
    x: number
    y: number
    event?: WorldEvent
  }>()
  const [toolsOpen, setToolsOpen, toolsClosing] = useMenuPresence<boolean>()
  useMenuEscape(() => setToolsOpen(null), !!toolsOpen)
  const toolsRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!toolsOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!toolsRoot.current?.contains(event.target as globalThis.Node)) setToolsOpen(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [toolsOpen, setToolsOpen])
  const [motion, setMotion] = useState(true)
  useEffect(() => {
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (
          container.current &&
          container.current.clientWidth > 0 &&
          container.current.clientHeight > 0
        )
          void instance.current?.fitView({ ...fitOptions, duration: 0 })
      })
    })
    if (container.current) observer.observe(container.current)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    const sync = () => setMotion(!media.matches && !document.hidden && visible)
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting
      sync()
    })
    if (container.current) observer.observe(container.current)
    sync()
    document.addEventListener('visibilitychange', sync)
    media.addEventListener('change', sync)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      media.removeEventListener('change', sync)
    }
  }, [])
  useEffect(() => {
    const preventNativeContextMenu = (event: globalThis.MouseEvent) => {
      if (event.target instanceof globalThis.Node && container.current?.contains(event.target)) {
        event.preventDefault()
      }
    }
    document.addEventListener('contextmenu', preventNativeContextMenu, true)
    return () => document.removeEventListener('contextmenu', preventNativeContextMenu, true)
  }, [])
  useEffect(() => {
    if (busy || (menu && !lines.some((line) => line.id === menu.id))) setMenu(null)
  }, [busy, lines, menu])
  const open = (
    event: Pick<MouseEvent, 'clientX' | 'clientY' | 'preventDefault' | 'stopPropagation'>,
    line: Line,
    at?: number,
    record?: WorldEvent,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const source =
      'currentTarget' in event && event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : document.activeElement
    const focusable =
      source instanceof HTMLElement
        ? (source.closest<HTMLElement>('button,[tabindex]') ??
          source.querySelector<HTMLElement>('button,[tabindex]'))
        : null
    if (focusable) {
      document.querySelector('[data-wl-panel-trigger]')?.removeAttribute('data-wl-panel-trigger')
      focusable.setAttribute('data-wl-panel-trigger', 'true')
    }
    const bounds = container.current?.getBoundingClientRect()
    if (!bounds) return
    const position = instance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const point = at ?? pointTime(position?.x ?? timeX(time), line)
    onSelect(line.id)
    onTimeChange(point)
    setMenu({
      id: line.id,
      event: record,
      at: point,
      x: event.clientX,
      y: event.clientY,
    })
  }
  const toggleLineMenu = (event: MouseEvent<HTMLElement>, line: Line) => {
    event.preventDefault()
    event.stopPropagation()
    if (menu?.id === line.id && !menuClosing) setMenu(null)
    else open(event, line, Math.max(Date.parse(line.createdAt), time))
  }
  const connections = canvasConnections(lines)
  const nodes: Track[] = lines.map((line, index) => {
    const born = timeX(Date.parse(line.createdAt))
    const relation = restoreRelation(events, line.id)
    const markers = eventMarkers(events, line, start, end, scale.toX, separatedIds, markerZoom)
    return {
      id: line.id,
      type: 'worldline',
      // Controlled node refreshes must not lose their dimensions between ResizeObserver deliveries.
      width: scale.right + 72 - born + 220,
      height: 76,
      handles: [
        { type: 'target', position: Position.Left, x: 0, y: 35.5, width: 1, height: 1 },
        ...lines
          .filter((child) =>
            connections.some((edge) => edge.source === line.id && edge.target === child.id),
          )
          .map((child) => ({
            id: child.id,
            type: 'source' as const,
            position: Position.Bottom,
            x: Math.max(0, timeX(Date.parse(child.forkedAt ?? child.createdAt)) - born - 40) - 0.5,
            y: 35.5,
            width: 1,
            height: 1,
          })),
      ],
      position: { x: born, y: 90 + index * ROW_HEIGHT },
      selected: selected === line.id,
      draggable: false,
      connectable: false,
      deletable: false,
      ariaLabel: `世界线 ${label(line)}，${stateLabel(line.state)}${line.initialization === 'clean' ? ' · 从干净环境创建' : ''}，Shift+F10 打开时间点菜单`,
      data: {
        line,
        missingParent: connections.some((edge) => edge.target === line.id && edge.missing),
        time,
        compared: comparisonIds.includes(line.id),
        markers,
        expandedIds: expanded.map((event) => event.id),
        menuOpen: menu?.id === line.id && !menuClosing,
        focusedEventId: focusEvent?.lineId === line.id ? focusEvent.id : undefined,
        restoration:
          relation &&
          !markers.some(
            (marker) =>
              marker.events.some((event) => event.id === relation.restore.id) &&
              marker.events.some((event) => event.id === relation.target.id),
          )
            ? {
                ...relation,
                fromX: markers.find((marker) =>
                  marker.events.some((event) => event.id === relation.restore.id),
                )!.x,
                toX: markers.find((marker) =>
                  marker.events.some((event) => event.id === relation.target.id),
                )!.x,
              }
            : null,
        enter: () => onEnter(line.id),
        inspect: (records) => {
          if (records.length === 1) onEvent(records[0]!)
          else if (records.every((record) => record.at === records[0]!.at)) onHistory(line.id)
          else {
            setMenu(null)
            onSelect(line.id)
            onTimeChange(Date.parse(records[0]!.at))
            if (!expanded.length) beforeExpandZoom.current = instance.current?.getZoom() ?? 1
            setExpanded(records)
          }
        },
        openEvent: (mouse, event) => open(mouse, line, Date.parse(event.at), event),
        width: scale.right + 72 - born,
        cursorX:
          selected === line.id && time >= Date.parse(line.createdAt)
            ? (markers.find((marker) => marker.events.some((event) => event.id === focusEvent?.id))
                ?.x ??
              markers.find((marker) => marker.events.some((event) => Date.parse(event.at) === time))
                ?.x ??
              markers.find((marker) => Math.abs(marker.x - (timeX(time) - born)) < 20)?.x ??
              timeX(time) - born)
            : null,
        forks: lines
          .filter((child) =>
            connections.some((edge) => edge.source === line.id && edge.target === child.id),
          )
          .map((child) => ({
            id: child.id,
            x: Math.max(0, timeX(Date.parse(child.forkedAt ?? child.createdAt)) - born - 40),
          })),
        active: selected === line.id,
        busy,
        dissolving: line.id === dissolvingId,
        experiments: experiments.filter((item) => (item.parentId ?? 'origin') === line.id),
        showExperiments: () => onExperiments(line.id),
        open: toggleLineMenu,
      },
    }
  })
  useEffect(() => {
    if (!focusEvent) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const node = nodes.find((node) => node.id === focusEvent.lineId)
        const marker = node?.data.markers.find((marker) =>
          marker.events.some((event) => event.id === focusEvent.id),
        )
        const bounds = container.current?.getBoundingClientRect()
        if (!node || !marker || !bounds) return
        const panel = container.current
          ?.closest('.wl-workspace')
          ?.querySelector('.wl-inspector')
          ?.getBoundingClientRect()
        const freeWidth =
          panel && panel.left > bounds.left
            ? Math.min(bounds.width, panel.left - bounds.left - 24)
            : bounds.width
        const zoom = collapseZoom.current ?? 1.5
        collapseZoom.current = null
        void instance.current?.setViewport(
          {
            x: freeWidth / 2 - (node.position.x + marker.x) * zoom,
            y: bounds.height / 2 - (node.position.y + 36) * zoom,
            zoom,
          },
          { duration: 250 },
        )
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [eventFocus, expanded])
  const edges: Branch[] = connections.map((connection) => ({
    id: `branch-${connection.target}`,
    source: connection.source,
    sourceHandle: connection.target,
    target: connection.target,
    type: 'branch',
    deletable: false,
    selectable: false,
    ariaLabel: connection.missing ? '原来源已删除或未显示，仅在画布中连接主干' : undefined,
    data: {
      active: selected === connection.target,
      color: lineColor(connection.target),
      stopped: lines.find((line) => line.id === connection.target)?.state === 'stopped',
      missingParent: connection.missing,
    },
  }))
  const lineIds = lines.map((line) => line.id).join(',')
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (
        container.current &&
        container.current.clientWidth > 0 &&
        container.current.clientHeight > 0
      )
        void instance.current?.fitView({ ...fitOptions, duration: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [lineIds])
  const menuLine = lines.find((line) => line.id === menu?.id)
  const flatMenuItems: MenuAction[] =
    menu && menuLine
      ? [
          {
            id: 'enter',
            label:
              menuLine.kind === 'origin'
                ? '返回 DSH'
                : menuLine.kind === 'rescue'
                  ? '进入救援实例'
                  : menuLine.state !== 'running'
                    ? '启动世界线'
                    : '进入世界线',
            icon: <ArrowRight size={16} />,
            disabled: busy || menuLine.kind === 'verification' || menuLine.state === 'applying',
            run: () =>
              menuLine.kind === 'mirror' && menuLine.state !== 'running'
                ? onManage('start', menuLine.id)
                : onEnter(menuLine.id),
          },
          ...(menuLine.kind === 'origin' || menuLine.kind === 'mirror'
            ? [
                {
                  id: 'composition',
                  label: '查看插件',
                  icon: <FileText size={16} />,
                  run: () => onComposition(menuLine.id),
                },
                {
                  id: 'install-plugin',
                  label: '安装并验证插件',
                  icon: <Plus size={16} />,
                  disabled: busy || menuLine.state === 'applying',
                  run: () => onInstall(menuLine.id),
                },
                {
                  id: 'experiments',
                  label: '查看验证实验',
                  icon: <FileText size={16} />,
                  run: () => onExperiments(menuLine.id),
                },
              ]
            : []),
          ...(menuLine.kind === 'rescue'
            ? [
                {
                  id: 'rescue-stop',
                  danger: true,
                  label: '停止救援实例',
                  icon: <Stop size={16} />,
                  disabled: busy,
                  run: () => onManage('stop', menuLine.id),
                },
              ]
            : [
                {
                  id: 'branch',
                  label: '世界线分支',
                  icon: <GitBranch size={16} />,
                  children: [
                    {
                      id: 'fork',
                      label: '创建旁路分支',
                      icon: <GitBranch size={16} />,
                      disabled: busy || menuLine.state === 'applying',
                      hint: '复制当前状态，不恢复历史数据',
                      run: () => onFork(menuLine.id, menu.at),
                    },
                    {
                      id: 'clean',
                      label: '从干净环境开始',
                      icon: <GitBranch size={16} />,
                      disabled: busy,
                      run: () => onFork(menuLine.id, undefined, undefined, true),
                    },
                    ...(menu.event?.snapshotId
                      ? [
                          {
                            id: 'snapshot-fork',
                            label: '从此快照创建世界线',
                            icon: <GitBranch size={16} />,
                            disabled: busy || !menu.event.restorable,
                            run: () => onFork(menuLine.id, menu.at, menu.event!.snapshotId),
                          },
                        ]
                      : []),
                  ],
                },
                {
                  id: 'history',
                  label: '快照与记录',
                  icon: <ClockCounterClockwise size={16} />,
                  children: [
                    {
                      id: 'save',
                      label: '保存配置快照',
                      icon: <Camera size={16} />,
                      disabled: busy || menuLine.state === 'applying',
                      run: () => onSnapshot(menuLine.id),
                    },
                    ...(menu.event
                      ? [
                          {
                            id: 'event',
                            label: '查看此事件',
                            icon: <ClockCounterClockwise size={16} />,
                            run: () => onEvent(menu.event!),
                          },
                        ]
                      : []),
                    {
                      id: 'history-list',
                      label: '查看事件记录',
                      icon: <ClockCounterClockwise size={16} />,
                      run: () => onHistory(menuLine.id),
                    },
                  ],
                },
                {
                  id: 'compare',
                  label: comparisonIds.includes(menuLine.id) ? '移出对比' : '加入双线对比',
                  icon: <ArrowsLeftRight size={16} />,
                  disabled: busy || menuLine.kind === 'verification',
                  run: () => onCompare(menuLine.id),
                },
                ...(menuLine.kind === 'verification'
                  ? [
                      {
                        id: 'verify',
                        label: '重验当前实验',
                        icon: <ArrowRight size={16} />,
                        disabled: busy || menuLine.state === 'applying',
                        run: () => onVerify(menuLine.id, false),
                      },
                      {
                        id: 'verify-login',
                        label: '登录后重验',
                        icon: <ArrowRight size={16} />,
                        disabled: busy || menuLine.state === 'applying',
                        run: () => onVerify(menuLine.id, true),
                      },
                      {
                        id: 'promote',
                        label: '合回来源环境',
                        icon: <UploadSimple size={16} />,
                        disabled: busy || menuLine.verdict !== 'passed',
                        hint:
                          menuLine.verdict === 'passed'
                            ? '提升验证结果到正式环境，进度在维护面板展示'
                            : '仅完整验证通过的实验可以合入',
                        run: () => onPromote(menuLine.id),
                      },
                      {
                        id: 'report',
                        label: '生成诊断报告',
                        icon: <FileText size={16} />,
                        disabled: busy,
                        run: () => onReport(menuLine.id),
                      },
                    ]
                  : []),
                ...(menuLine.kind !== 'origin'
                  ? [
                      {
                        id: 'manage',
                        label: '世界线管理',
                        icon: <DotsThree size={17} />,
                        children: [
                          {
                            id: 'merge',
                            label: '合入到…',
                            icon: <GitMerge size={16} />,
                            disabled:
                              busy ||
                              !mergeAvailable ||
                              menuLine.kind !== 'mirror' ||
                              menuLine.state === 'applying',
                            hint: mergeAvailable
                              ? undefined
                              : '当前实例需重启后启用合入；也可在主干画布操作',
                            run: () => onMerge(menuLine.id),
                          },
                          {
                            id: 'default',
                            label: menuLine.isDefault ? '已是默认世界线' : '设为默认世界线',
                            icon: <Star size={16} />,
                            disabled: busy || menuLine.kind !== 'mirror' || menuLine.isDefault,
                            run: () => onManage('default', menuLine.id),
                          },
                          {
                            id: 'alias',
                            label: '修改别名',
                            icon: <PencilSimple size={16} />,
                            disabled: busy || menuLine.state === 'applying',
                            run: () => onManage('alias', menuLine.id),
                          },
                          {
                            id: 'stop',
                            danger: true,
                            label: '停止世界线',
                            icon: <Stop size={16} />,
                            disabled:
                              busy ||
                              !['running', 'unreachable'].includes(menuLine.state) ||
                              menuLine.id === currentId,
                            hint:
                              menuLine.id === currentId ? '请在另一实例停止当前世界线' : undefined,
                            run: () => onManage('stop', menuLine.id),
                          },
                          {
                            id: 'destroy',
                            label: '删除世界线…',
                            icon: <Trash size={16} />,
                            danger: true,
                            disabled:
                              busy ||
                              ['running', 'applying', 'unreachable'].includes(menuLine.state) ||
                              menuLine.id === currentId,
                            hint:
                              menuLine.id === currentId
                                ? '不能删除当前所在世界线'
                                : ['running', 'unreachable'].includes(menuLine.state)
                                  ? '请先停止世界线'
                                  : undefined,
                            run: () => onManage('destroy', menuLine.id),
                          },
                        ],
                      },
                    ]
                  : []),
              ]),
        ]
      : []
  const ticks = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) =>
        scale.toTime(TRACK_LEFT + ((scale.right - TRACK_LEFT) * index) / 4),
      ),
    [scale],
  )
  const leafItems = flatMenuItems.flatMap((item) => item.children ?? [item])
  const group = (
    id: string,
    label: string,
    ids: string[],
    icon: MenuAction['icon'],
  ): MenuAction => ({
    id,
    label,
    icon,
    children: ids.flatMap((id) => leafItems.filter((item) => item.id === id)),
  })
  if (menuLine?.kind === 'mirror')
    leafItems.push({
      id: 'restart',
      label: '重启世界线',
      icon: <ArrowRight size={16} />,
      disabled: busy || menuLine.id === currentId || menuLine.state === 'applying',
      hint: '停止并重新加载当前世界线，配置与历史保留',
      run: () => onManage('restart', menuLine.id),
    })
  const menuItems: MenuAction[] = [
    group(
      'runtime',
      '实例操作',
      ['enter', 'restart', 'stop', 'rescue-stop', 'destroy'],
      <ArrowRight size={16} />,
    ),
    group(
      'plugins',
      '插件与验证',
      [
        'composition',
        'install-plugin',
        'experiments',
        'verify',
        'verify-login',
        'promote',
        'report',
      ],
      <FileText size={16} />,
    ),
    group(
      'history',
      '快照与对比',
      ['save', 'event', 'history-list', 'compare'],
      <ClockCounterClockwise size={16} />,
    ),
    group(
      'branches',
      '分支与合入',
      ['fork', 'clean', 'snapshot-fork', 'merge'],
      <GitBranch size={16} />,
    ),
    group('settings', '世界线设置', ['default', 'alias'], <DotsThree size={17} />),
  ].filter((item) => item.children!.length > 0)

  const renderedMergeLinks = new Set<string>()
  return (
    <div
      className="wl-map wl-flow-map"
      ref={container}
      data-motion={motion}
      aria-label="世界线图谱"
      onContextMenuCapture={(event) => {
        // Capture the whole canvas: text, rails, handles and blank pane must not leak to Chrome.
        if ((event.target as HTMLElement).closest('.wl-menu-layer')) return
        event.preventDefault()
        const target = event.target as Element
        const nodeId =
          target.closest('.react-flow__node')?.getAttribute('data-id') ??
          target.closest('[data-line-id]')?.getAttribute('data-line-id')
        const edgeId = target.closest('.react-flow__edge')?.getAttribute('data-id')
        const recordId = target.closest('[data-event-id]')?.getAttribute('data-event-id')
        const record = events.find((item) => item.id === recordId)
        const line =
          lines.find(
            (item) => item.id === (record?.lineId ?? nodeId ?? edgeId?.replace(/^branch-/, '')),
          ) ??
          lines.find((item) => item.id === selected) ??
          lines[0]
        if (line)
          open(
            event,
            line,
            record
              ? Date.parse(record.at)
              : nodeId
                ? undefined
                : Math.max(Date.parse(line.createdAt), time),
            record,
          )
      }}
    >
      <div
        className="wl-flow-desktop"
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          const node = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')
          const line = lines.find((candidate) => candidate.id === node?.dataset.id)
          if (!line || !node) return
          event.preventDefault()
          const rect = node.getBoundingClientRect()
          open(
            {
              preventDefault() {},
              stopPropagation() {},
              clientX: Math.min(rect.right - 30, window.innerWidth - 30),
              clientY: rect.top + 36,
            },
            line,
            Math.max(Date.parse(line.createdAt), time),
          )
        }}
      >
        <ReactFlow<Track, Branch>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(flow) => {
            instance.current = flow
            setMarkerZoom(flow.getZoom())
          }}
          fitView
          fitViewOptions={fitOptions}
          minZoom={0.25}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          preventScrolling
          onNodeClick={(event, node) => {
            if (busy) return
            setMenu(null)
            if (event.shiftKey) {
              onCompare(node.id)
              return
            }
            onSelect(node.id)
            const point = instance.current?.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            })
            if (point) onTimeChange(pointTime(point.x, node.data.line))
          }}
          onNodeContextMenu={(event, node) => open(event, node.data.line)}
          onEdgeContextMenu={(event, edge) => {
            const line = lines.find((candidate) => candidate.id === edge.target)
            if (line) open(event, line, Date.parse(line.createdAt))
          }}
          onPaneClick={() => setMenu(null)}
          onMoveStart={() => setMenu(null)}
          onMove={(_, viewport) =>
            setMarkerZoom((previous) => clusterZoom(previous, viewport.zoom))
          }
          aria-label="世界线时间轴，拖动画布平移，捏合缩放，右键时间点打开操作"
        >
          <ViewportPortal>
            <svg
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: scale.right + 72,
                height: 180 + lines.length * ROW_HEIGHT,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
              aria-label="世界线合入连线"
            >
              {events
                .filter((event) => event.kind === 'merge')
                .map((event) => {
                  const source = nodes.find((node) => node.id === event.sourceLineId)
                  const target = nodes.find((node) => node.id === event.lineId)
                  const marker = target?.data.markers.find((marker) =>
                    marker.events.some((item) => item.id === event.id),
                  )
                  if (!source || !target || !marker || source === target) return null
                  const x = target.position.x + marker.x
                  // Connect the last visible source event that existed when this merge completed.
                  // Use its rendered center; the path offsets to the source’s right edge.
                  const sourceMarker = source.data.markers
                    .flatMap((marker) =>
                      marker.events
                        .filter((item) => Date.parse(item.at) <= Date.parse(event.at))
                        .map((item) => ({ marker, at: Date.parse(item.at) })),
                    )
                    .sort((a, b) => b.at - a.at)[0]?.marker
                  const fromX = source.position.x + (sourceMarker ? sourceMarker.x : 0)
                  const linkKey = `${source.id}:${fromX}:${target.id}:${x}`
                  if (renderedMergeLinks.has(linkKey)) return null
                  renderedMergeLinks.add(linkKey)
                  const fromY = source.position.y + 36
                  const toY = target.position.y + 36
                  const arrow = `wl-merge-arrow-${event.id.replace(/[^a-zA-Z0-9-]/g, '-')}`
                  return (
                    <g key={event.id} style={{ color: lineColor(event.sourceLineId!) }}>
                      <title>{event.title}</title>
                      <defs>
                        <marker
                          id={arrow}
                          viewBox="0 0 8 8"
                          refX="7"
                          refY="4"
                          markerWidth="7"
                          markerHeight="7"
                          orient="auto"
                          markerUnits="userSpaceOnUse"
                        >
                          <path
                            d="M 1 1 L 7 4 L 1 7"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </marker>
                      </defs>
                      <path
                        d={mergeConnectionPath(fromX, fromY, x, toY)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        opacity=".85"
                        markerEnd={`url(#${arrow})`}
                      />
                    </g>
                  )
                })}
            </svg>
            <div
              className="wl-flow-ruler"
              style={{ width: scale.right + 72, height: 30 + lines.length * ROW_HEIGHT }}
              aria-hidden="true"
            >
              {ticks.map((at) => (
                <div className="wl-flow-tick" key={at} style={{ left: timeX(at) }}>
                  <span>
                    {new Date(at).toLocaleString([], {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              ))}
              {scale.gaps.map((gap) => (
                <div
                  className="wl-time-gap"
                  key={gap.from}
                  style={{ left: (gap.left + gap.right) / 2 }}
                >
                  <span>
                    ⫽ 空白{' '}
                    {gap.duration >= 86400000
                      ? `${(gap.duration / 86400000).toFixed(1)} 天`
                      : `${(gap.duration / 3600000).toFixed(1)} 小时`}{' '}
                    ⫽
                  </span>
                </div>
              ))}
              <div
                className="wl-flow-cursor"
                style={{
                  left: (() => {
                    const node = nodes.find((node) => node.id === selected)
                    return node?.data.cursorX != null
                      ? node.position.x + node.data.cursorX
                      : timeX(time)
                  })(),
                }}
              >
                <span>回看位置</span>
              </div>
            </div>
          </ViewportPortal>
          <Panel position="bottom-right" className="wl-flow-help">
            ◆ 快照 · ○ 事件
          </Panel>
          <Panel position="bottom-left" className="wl-flow-controls">
            <div
              ref={toolsRoot}
              className="wl-map-tools"
              data-open={!!toolsOpen}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setToolsOpen(null)
                  event.currentTarget.querySelector<HTMLButtonElement>('.wl-map-toggle')?.focus()
                }
              }}
            >
              <button
                type="button"
                className="wl-map-toggle"
                aria-label="画布工具"
                title="画布工具"
                aria-expanded={!!toolsOpen && !toolsClosing}
                aria-controls="wl-canvas-tools"
                onClick={() => setToolsOpen(toolsOpen && !toolsClosing ? null : true)}
              >
                <span className="wl-system-icon">
                  <SlidersHorizontal size={18} />
                </span>
              </button>
              {toolsOpen && (
                <div
                  id="wl-canvas-tools"
                  className="wl-system-menu wl-map-menu"
                  role="group"
                  aria-label="画布缩放工具"
                  data-closing={toolsClosing}
                  inert={toolsClosing}
                >
                  <div className="wl-system-items">
                    {[
                      {
                        label: '放大图谱',
                        icon: <Plus size={16} />,
                        run: () => void instance.current?.zoomIn(),
                      },
                      {
                        label: '缩小图谱',
                        icon: <Minus size={16} />,
                        run: () => void instance.current?.zoomOut(),
                      },
                      {
                        label: '适应全部世界线',
                        icon: <CornersOut size={16} />,
                        run: () => {
                          if (expanded.length) {
                            resetView.current = true
                            setExpanded([])
                          } else void instance.current?.fitView(fitOptions)
                        },
                      },
                    ].map((action, index) => (
                      <button
                        key={action.label}
                        className="wl-system-item"
                        aria-label={action.label}
                        style={menuItemMotion(index, 3, true)}
                        onClick={action.run}
                      >
                        <span className="wl-system-icon" aria-hidden="true">
                          {action.icon}
                        </span>
                        <span className="wl-system-label">{action.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
      </div>
      <div className="wl-mobile-list">
        {lines.map((line) => (
          <div
            className="wl-mobile-row"
            key={line.id}
            data-line-id={line.id}
            data-selected={line.id === selected}
            style={{ '--wl-line-color': lineColor(line.id) } as CSSProperties}
            onContextMenu={(event) => open(event, line, Math.max(Date.parse(line.createdAt), time))}
          >
            <button
              className="wl-line-info"
              onClick={(event) => (event.shiftKey ? onCompare(line.id) : onSelect(line.id))}
              disabled={busy}
              aria-pressed={line.id === selected}
            >
              <span className="wl-row-title">
                <strong>{label(line)}</strong>
                {line.isDefault && <span className="wl-badge">默认</span>}
              </span>
              <span className="wl-status" data-running={line.state === 'running'}>
                <Circle
                  size={7}
                  weight="fill"
                  className={line.state === 'running' ? 'wl-live-dot' : ''}
                />
                {stateLabel(line.state)}
                {line.initialization === 'clean' ? ' · 从干净环境创建' : ''}
                {line.port ? ` · ${line.port}` : ''}
              </span>
              <span className="wl-muted">
                {connections.some((edge) => edge.target === line.id && edge.missing)
                  ? '原来源已删除或未显示 · 虚线连接主干'
                  : line.parentId
                    ? `源自 ${label(lines.find((item) => item.id === line.parentId) ?? { ...line, alias: '未显示的来源' })}`
                    : '正式环境'}{' '}
                ·{' '}
                {new Date(line.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </button>
            <button
              className="wl-button wl-icon"
              aria-label={`${label(line)} 事件记录`}
              onClick={() => onHistory(line.id)}
            >
              <ClockCounterClockwise size={16} />
            </button>
            <button
              className="wl-button wl-icon"
              aria-label={`${label(line)} 时间点操作`}
              aria-haspopup="menu"
              disabled={busy}
              data-wl-menu-toggle
              aria-expanded={menu?.id === line.id && !menuClosing}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => toggleLineMenu(event, line)}
            >
              <DotsThree size={20} />
            </button>
          </div>
        ))}
      </div>
      {menu && menuLine && container.current?.closest<HTMLElement>('.wl-page') && (
        <ContextMenu
          key={`${menu.id}:${menu.x}:${menu.y}:${menu.at}`}
          x={menu.x}
          y={menu.y}
          title={label(menuLine)}
          subtitle={timestamp(menu.at)}
          status={`${stateLabel(menuLine.state)}${menuLine.port ? ` · ${menuLine.port}` : ''}${menuLine.id === currentId ? ' · 当前所在' : ''}`}
          host={container.current.closest<HTMLElement>('.wl-page')!}
          items={menuItems}
          closing={menuClosing}
          close={() => setMenu(null)}
        />
      )}
    </div>
  )
}
