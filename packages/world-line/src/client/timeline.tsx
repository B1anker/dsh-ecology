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
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { WorldEvent } from '../domain/insight-types.js'
import { ContextMenu, type MenuAction } from './context-menu.js'
import {
  eventMarkers,
  type Line,
  label,
  lineColor,
  ROW_HEIGHT,
  stateLabel,
  TRACK_END,
  TRACK_LEFT,
  timelineScale,
} from './timeline-model.js'

export { type Line, label, stateLabel } from './timeline-model.js'

type TrackData = {
  line: Line
  experiments: Line[]
  showExperiments(): void
  width: number
  time: number
  cursorX: number | null
  forks: { id: string; x: number }[]
  active: boolean
  busy: boolean
  compared: boolean
  markers: { x: number; events: WorldEvent[] }[]
  enter(): void
  inspect(event: WorldEvent): void
  openEvent(mouse: MouseEvent<HTMLElement>, event: WorldEvent): void
  open(event: MouseEvent<HTMLElement>, line: Line): void
}
type Track = Node<TrackData, 'worldline'>
type Branch = Edge<{ active: boolean; color: string; stopped: boolean }, 'branch'>
function TrackNode({ id, data }: NodeProps<Track>) {
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
          return (
            <button
              key={event.id}
              className="wl-event-marker nodrag nopan"
              data-event-id={event.id}
              data-kind={event.kind}
              data-ahead={marker.events.every((item) => Date.parse(item.at) > data.time)}
              data-at-cursor={marker.events.some((item) => Date.parse(item.at) === data.time)}
              style={{ left: marker.x }}
              title={`${event.title} · ${timestamp(Date.parse(event.at))}${marker.events.length > 1 ? ` · ${marker.events.length} 个事件` : ''}`}
              aria-label={`${label(line)} ${event.title}${marker.events.length > 1 ? ` 等 ${marker.events.length} 个事件` : ''}`}
              disabled={data.busy}
              onClick={(mouse) => {
                mouse.stopPropagation()
                data.inspect(event)
              }}
              onContextMenu={(mouse) => {
                mouse.stopPropagation()
                data.openEvent(mouse, event)
              }}
            >
              {marker.events.length > 1
                ? marker.events.length
                : event.kind === 'snapshot'
                  ? '◆'
                  : '○'}
            </button>
          )
        })}
        {line.state === 'running' && <span className="wl-flow-energy" />}
        {data.cursorX !== null && (
          <span
            className="wl-time-point"
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
      </div>
      <button
        className="wl-button wl-icon wl-point-action nodrag nopan"
        aria-label={`${label(line)} 时间点操作`}
        aria-haspopup="menu"
        disabled={data.busy}
        onClick={(event) => {
          event.stopPropagation()
          data.open(event, line)
        }}
      >
        <DotsThree size={20} />
      </button>
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
        strokeDasharray: data?.stopped ? '6 4' : undefined,
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
}) {
  const scale = useMemo(
    () =>
      timelineScale(start, end, [
        ...events.map((event) => Date.parse(event.at)),
        ...lines.flatMap((line) => [
          Date.parse(line.createdAt),
          Date.parse(line.forkedAt ?? line.createdAt),
        ]),
      ]),
    [start, end, events, lines],
  )
  const timeX = scale.toX
  const pointTime = (x: number, line: Line) => Math.max(Date.parse(line.createdAt), scale.toTime(x))
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactFlowInstance<Track, Branch> | null>(null)
  const [menu, setMenu] = useState<{
    id: string
    at: number
    x: number
    y: number
    event?: WorldEvent
  } | null>(null)
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
  const nodes: Track[] = lines.map((line, index) => {
    const born = timeX(Date.parse(line.createdAt))
    const markers = eventMarkers(events, line, start, end, scale.toX)
    return {
      id: line.id,
      type: 'worldline',
      // Controlled node refreshes must not lose their dimensions between ResizeObserver deliveries.
      width: TRACK_END + 72 - born + 220,
      height: 76,
      handles: [
        { type: 'target', position: Position.Left, x: 0, y: 35.5, width: 1, height: 1 },
        ...lines
          .filter((child) => child.parentId === line.id)
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
        time,
        compared: comparisonIds.includes(line.id),
        markers,
        enter: () => onEnter(line.id),
        inspect: onEvent,
        openEvent: (mouse, event) => open(mouse, line, Date.parse(event.at), event),
        width: TRACK_END + 72 - born,
        cursorX:
          selected === line.id && time >= Date.parse(line.createdAt)
            ? (markers.find((marker) =>
                marker.events.some((event) => Date.parse(event.at) === time),
              )?.x ??
              markers.find((marker) => Math.abs(marker.x - (timeX(time) - born)) < 20)?.x ??
              timeX(time) - born)
            : null,
        forks: lines
          .filter((child) => child.parentId === line.id)
          .map((child) => ({
            id: child.id,
            x: Math.max(0, timeX(Date.parse(child.forkedAt ?? child.createdAt)) - born - 40),
          })),
        active: selected === line.id,
        busy,
        experiments: experiments.filter((item) => (item.parentId ?? 'origin') === line.id),
        showExperiments: () => onExperiments(line.id),
        open: (event, target) => open(event, target, Math.max(Date.parse(target.createdAt), time)),
      },
    }
  })
  const edges: Branch[] = lines
    .filter((line) => lines.some((parent) => parent.id === line.parentId))
    .map((line) => ({
      id: `branch-${line.id}`,
      source: line.parentId!,
      sourceHandle: line.id,
      target: line.id,
      type: 'branch',
      deletable: false,
      selectable: false,
      data: {
        active: selected === line.id,
        color: lineColor(line.id),
        stopped: line.state === 'stopped',
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
                  label: '查看组成',
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
                            label: '合入主干',
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
        scale.toTime(TRACK_LEFT + ((TRACK_END - TRACK_LEFT) * index) / 4),
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
          aria-label="世界线时间轴，拖动画布平移，捏合缩放，右键时间点打开操作"
        >
          <ViewportPortal>
            <div
              className="wl-flow-ruler"
              style={{ width: TRACK_END + 72, height: 30 + lines.length * ROW_HEIGHT }}
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
            ◆ 快照 · ○ 事件 · 淡色表示游标之后
            {scale.compressed ? ' · 长空白已压缩，时间以刻度为准' : ''}
          </Panel>
          <Panel position="bottom-left" className="wl-flow-controls">
            <details className="wl-map-tools">
              <summary aria-label="画布工具" title="画布工具">
                <SlidersHorizontal size={18} />
              </summary>
              <div>
                <button
                  className="wl-button wl-icon"
                  aria-label="放大图谱"
                  onClick={() => void instance.current?.zoomIn()}
                >
                  <Plus size={16} />
                </button>
                <button
                  className="wl-button wl-icon"
                  aria-label="缩小图谱"
                  onClick={() => void instance.current?.zoomOut()}
                >
                  <Minus size={16} />
                </button>
                <button
                  className="wl-button wl-icon"
                  aria-label="适应全部世界线"
                  onClick={() => void instance.current?.fitView(fitOptions)}
                >
                  <CornersOut size={16} />
                </button>
              </div>
            </details>
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
                {line.parentId
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
              onClick={(event) => open(event, line, Math.max(Date.parse(line.createdAt), time))}
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
          close={() => setMenu(null)}
        />
      )}
    </div>
  )
}
