import { ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise'
import { ArrowsLeftRight } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
import { Camera } from '@phosphor-icons/react/dist/csr/Camera'
import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise'
import { GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { Plus } from '@phosphor-icons/react/dist/csr/Plus'
import { WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle'
import { X } from '@phosphor-icons/react/dist/csr/X'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorldEvent } from '../domain/insight-types.js'
import { useWorldLineEntry } from './entry.js'
import { Inspector, type InspectorState } from './inspector.js'
import { MergePanel } from './merge-panel.js'
import { styles } from './styles.js'
import { TimeControls } from './time-controls.js'
import { type Line, label, Timeline } from './timeline.js'
import { aliasValidation, cursorTime } from './timeline-model.js'

declare const worldLineFlowCss: string
export const name = '@seaveyon/dsh-world-line'
export const inject = ['slots']
interface Data {
  lines: Line[]
  events: WorldEvent[]
  eventWarnings: string[]
  profile: string
  currentId: string | null
  capabilities?: { merge: boolean }
  now: string
}
async function api(body?: unknown, signal?: AbortSignal) {
  const response = await fetch(
    '/api/world-line',
    body
      ? {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store', signal },
  )
  if (response.status === 401 || response.status === 403)
    throw new Error('登录已失效，请返回 DSH 重新登录后再试。')
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('未收到管理服务响应，请检查连接或重新登录。')
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`)
  return data
}
function WorldLine({ close, onBusyChange }: { close(): void; onBusyChange(value: boolean): void }) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('')
  useEffect(() => {
    onBusyChange(!!busy)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])
  const [selected, setSelected] = useState(''),
    [query, setQuery] = useState('')
  const [loadError, setLoadError] = useState(''),
    [refreshing, setRefreshing] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const { begin: beginEntry, entry } = useWorldLineEntry()
  const restoreFocus = useRef<HTMLElement | null>(null)
  const request = useRef<AbortController | null>(null),
    operation = useRef(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])
  const [showChecks, setShowChecks] = useState(false)
  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const [mergeId, setMergeId] = useState<string | null>(null)
  const [comparisonIds, setComparisonIds] = useState<string[]>([])
  const [dialog, setDialog] = useState<{
    type: 'create' | 'alias' | 'destroy' | 'snapshot'
    id?: string
    from?: string
    at?: number
    snapshotId?: string
  } | null>(null)
  const [alias, setAlias] = useState(''),
    [notice, setNotice] = useState(''),
    [cursor, setCursor] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null),
    input = useRef<HTMLInputElement>(null)
  const refresh = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setRefreshing(true)
    try {
      const result: Data = await api(undefined, controller.signal)
      if (controller.signal.aborted) return
      setData(result)
      setSelected((value) =>
        value === 'origin' || result.lines.some((line) => line.id === value)
          ? value
          : (result.currentId ?? 'origin'),
      )
      setLoadError('')
    } catch (e) {
      if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : '加载失败')
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      if (!document.hidden && !operation.current) void refresh()
    }, 10000)
    return () => {
      clearInterval(timer)
      request.current?.abort()
    }
  }, [refresh])
  useEffect(() => {
    if (!dialog) return
    restoreFocus.current = document.activeElement as HTMLElement | null
    const form = panel.current?.querySelector<HTMLElement>('.wl-dialog')
    const focus = () => (input.current ?? form?.querySelector<HTMLElement>('button'))?.focus()
    focus()
    const guard = (event: FocusEvent) => {
      if (form && !form.contains(event.target as Node)) focus()
    }
    document.addEventListener('focusin', guard)
    const siblings = Array.from(panel.current?.children ?? []).filter(
      (element) => !element.classList.contains('wl-dialog-backdrop'),
    ) as HTMLElement[]
    siblings.forEach((element) => {
      element.inert = true
    })
    return () => {
      document.removeEventListener('focusin', guard)
      siblings.forEach((element) => {
        element.inert = false
      })
      restoreFocus.current?.focus()
    }
  }, [dialog])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    // The host owns the sidebar width. Read its grid geometry without replacing a slot owner.
    const frame = document.querySelector('[data-shell-overlay]')?.parentElement
    const sync = () => {
      const liveFrame =
        panel.current?.closest('[data-shell-overlay]')?.parentElement ??
        document.querySelector('[data-shell-overlay]')?.parentElement
      if (liveFrame)
        panel.current?.style.setProperty(
          '--wl-left',
          getComputedStyle(liveFrame).gridTemplateColumns.split(' ')[0] ?? '280px',
        )
    }
    sync()
    let frameId = 0
    const scheduleSync = () => {
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(sync)
    }
    window.addEventListener('resize', scheduleSync)
    const observer = new MutationObserver(scheduleSync)
    if (frame) observer.observe(frame, { attributes: true, attributeFilter: ['style'] })
    const resize = new ResizeObserver(scheduleSync)
    if (frame) {
      resize.observe(frame)
      if (frame.firstElementChild) resize.observe(frame.firstElementChild)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busy) return
        if (mergeId) {
          setMergeId(null)
          return
        }
        if (dialog) {
          if (!busy) setDialog(null)
        } else if (inspector) setInspector(null)
        else close()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      observer.disconnect()
      resize.disconnect()
      cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleSync)
      document.removeEventListener('keydown', key)
    }
  }, [close, dialog, busy, inspector, mergeId])
  const current = data?.lines.find((line) => line.id === selected)
  const earliest =
    Math.min(
      ...(data?.lines.map((line) => Date.parse(line.createdAt)) ?? []),
      ...(data?.events?.map((event) => Date.parse(event.at)) ?? []),
      Date.now(),
    ) - 60000
  const latest = Math.max(Date.parse(data?.now ?? new Date().toISOString()), earliest + 1)
  const time = cursorTime(cursor, latest)
  const origin: Line = {
    id: 'origin',
    alias: 'main',
    createdAt: new Date(earliest).toISOString(),
    kind: 'origin',
    state: '来源环境',
    verdict: null,
    isDefault: false,
  }
  const dialogLine =
    dialog?.id === 'origin' ? origin : data?.lines.find((line) => line.id === dialog?.id)
  const all = data
    ? [
        origin,
        ...data.lines
          .filter((line) => showChecks || line.kind === 'mirror' || line.id === data.currentId)
          .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((line) => ({ ...line, parentId: line.parentId ?? 'origin' })),
      ]
    : []
  const matches = all.filter(
    (line) =>
      !query.trim() ||
      label(line).toLowerCase().includes(query.trim().toLowerCase()) ||
      line.id.includes(query.trim()),
  )
  const visible = new Set(matches.map((line) => line.id))
  for (const line of matches) {
    let parent = line.parentId
    while (parent && !visible.has(parent)) {
      visible.add(parent)
      parent = all.find((item) => item.id === parent)?.parentId
    }
  }
  const lines = all.filter((line) => visible.has(line.id))
  const aliasError =
    dialog?.type === 'snapshot'
      ? !alias.trim()
        ? '请输入快照名称'
        : [...alias].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
            alias.length > 200
          ? '名称最多 200 字，不含控制字符'
          : ''
      : aliasValidation(
          alias,
          data?.lines ?? [],
          dialog?.type === 'alias' ? dialog.id : undefined,
          !!busy,
        )
  const openCreate = (from?: string, at?: number, snapshotId?: string) => {
    setDialog({ type: 'create', from: from === 'origin' ? undefined : from, at, snapshotId })
    setAlias('')
    setError('')
  }
  const openSnapshot = (id: string) => {
    setDialog({ type: 'snapshot', id })
    setAlias('')
    setError('')
  }
  const inspectEvent = (event: WorldEvent) => {
    setSelected(event.lineId)
    setCursor(Date.parse(event.at))
    setInspector({ type: 'history', id: event.lineId, eventId: event.id })
  }
  const compareSelect = (id: string) => {
    setComparisonIds((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids.slice(-1), id],
    )
    setInspector({ type: 'compare' })
  }
  const perform = async (body: Record<string, unknown>, enter = false) => {
    if (operation.current) return
    operation.current = true
    request.current?.abort()
    setRefreshing(false)
    setBusy(
      body.action === 'create'
        ? '正在复制世界线并启动，首次安装依赖可能需要几分钟…'
        : body.action === 'snapshot'
          ? '正在保存插件与配置快照…'
          : '正在处理…',
    )
    setError('')
    setNotice('')
    const destination = data?.lines.find((line) => line.id === body.id)
    const dive = enter
      ? beginEntry(
          destination ? label(destination) : String(body.id),
          String(body.id),
          panel.current!,
        )
      : undefined
    try {
      const result = await api(body)
      if (result.id) setSelected(result.id)
      if (body.action === 'create') setCursor(null)
      setDialog(null)
      if (dive) {
        if (!result.url) throw new Error('目标实例未返回进入地址，请重试。')
        await dive.finish(result.url)
      } else {
        setNotice(
          body.action === 'create'
            ? '新的世界线已启动。选择「进入世界线」即可打开。'
            : body.action === 'snapshot'
              ? `快照已保存。${result.warnings?.length ? '部分内容有限制，请查看快照详情。' : ''}`
              : '已更新',
        )
      }
      await refresh()
      if (body.action === 'snapshot') {
        setCursor(null)
        setInspector({
          type: 'history',
          id: String(body.id),
          eventId: `${body.id}:${result.snapshotId}`,
        })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作失败'
      dive?.fail(message)
      setError(message)
    } finally {
      setBusy('')
      operation.current = false
    }
  }
  return (
    <section className="wl-page" ref={panel} aria-label="世界线管理">
      {entry}
      <header className="wl-canvas-header">
        <div className="wl-canvas-brand">
          <GitBranch size={19} />
          <h1>世界线</h1>
          <span>{data?.lines.filter((line) => line.kind === 'mirror').length ?? 0}</span>
        </div>
        <div className="wl-icon-toolbar" role="toolbar" aria-label="世界线工具">
          <button
            className="wl-button wl-icon"
            aria-label="搜索世界线"
            title="搜索世界线"
            aria-expanded={searchOpen}
            aria-pressed={!!query}
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <MagnifyingGlass size={18} />
          </button>
          <button
            className="wl-button wl-icon"
            aria-label="显示验证实验"
            title="显示验证实验"
            aria-pressed={showChecks}
            onClick={() => {
              setShowChecks(!showChecks)
              if (showChecks && current?.kind === 'verification' && current.id !== data?.currentId)
                setSelected(data?.currentId ?? 'origin')
            }}
          >
            <CheckCircle size={18} />
          </button>
          <button
            className="wl-button wl-icon"
            aria-label="刷新"
            title="刷新"
            onClick={() => void refresh()}
            disabled={!!busy}
          >
            <ArrowsClockwise size={18} className={refreshing ? 'wl-spin' : ''} />
          </button>
          <span className="wl-tool-divider" />
          <button
            className="wl-button wl-icon"
            aria-label="事件记录"
            title="事件记录"
            aria-pressed={inspector?.type === 'history'}
            onClick={() =>
              setInspector(
                inspector?.type === 'history'
                  ? null
                  : { type: 'history', id: selected || 'origin' },
              )
            }
          >
            <ClockCounterClockwise size={18} />
          </button>
          <button
            className="wl-button wl-icon"
            aria-label="保存快照"
            title="保存快照"
            disabled={!!busy || !data}
            onClick={() => openSnapshot(selected || 'origin')}
          >
            <Camera size={18} />
          </button>
          <button
            className="wl-button wl-icon"
            aria-label="双线对比"
            title="双线对比 · Shift 点击两条线"
            aria-pressed={inspector?.type === 'compare'}
            onClick={() => {
              setComparisonIds((ids) => (ids.length ? ids : [selected || 'origin']))
              setInspector(inspector?.type === 'compare' ? null : { type: 'compare' })
            }}
            disabled={!!busy}
          >
            <ArrowsLeftRight size={18} />
          </button>
          <button
            className="wl-button wl-icon wl-primary"
            aria-label="新世界线"
            title="新世界线"
            onClick={() => openCreate()}
            disabled={!!busy}
          >
            <Plus size={18} />
          </button>
        </div>
      </header>
      {searchOpen && (
        <div
          className="wl-search-popover"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (busy) return
              if (mergeId) {
                setMergeId(null)
                return
              }
              event.stopPropagation()
              setSearchOpen(false)
            }
          }}
        >
          <label className="wl-search">
            <MagnifyingGlass size={18} />
            <input
              ref={searchInput}
              placeholder="查找世界线"
              aria-label="查找世界线"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {query && (
            <button
              className="wl-button wl-icon"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      <div className="wl-feedback" aria-live="polite">
        {(error || loadError) && !dialog && (
          <div className="wl-alert wl-error" role="alert">
            <WarningCircle size={18} />
            <span>{error || loadError}</span>
            <button
              className="wl-button"
              onClick={() => {
                setError('')
                void refresh()
              }}
            >
              重试
            </button>
          </div>
        )}
        {busy && !dialog && (
          <div className="wl-alert" role="status">
            <CircleNotch className="wl-spin" size={18} />
            <span>{busy}</span>
          </div>
        )}
        {notice && !busy && (
          <div className="wl-alert wl-success" role="status">
            <CheckCircle size={18} />
            <span>{notice}</span>
            <button
              className="wl-button wl-icon"
              aria-label="关闭提示"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="wl-workspace">
        {!data ? (
          <div className="wl-empty" role="status">
            <CircleNotch size={28} className="wl-spin" />
            <p>{loadError ? '连接暂时不可用，请重试' : '正在读取世界线…'}</p>
          </div>
        ) : !data.lines.length && !data.events?.length ? (
          <div className="wl-empty">
            <GitBranch size={36} />
            <h2>从这里，让世界分岔</h2>
            <p>从当前正式环境创建独立实例，保留配置与账户绑定。</p>
            <button className="wl-button wl-primary" onClick={() => openCreate()}>
              创建第一条世界线
            </button>
          </div>
        ) : matches.length === 0 ? (
          <div className="wl-empty">
            <MagnifyingGlass size={28} />
            <h2>没有找到这条世界线</h2>
            <p>试试别名或完整 ID。</p>
            <button className="wl-button" onClick={() => setQuery('')}>
              清除搜索
            </button>
          </div>
        ) : (
          <Timeline
            lines={lines}
            busy={!!busy}
            selected={selected}
            currentId={data.currentId}
            onManage={(action, id) => {
              const target = data.lines.find((line) => line.id === id)
              if (!target || busy) return
              setSelected(id)
              if (action === 'alias' || action === 'destroy') {
                setError('')
                setAlias(target.alias ?? '')
                setDeleteConfirmation('')
                setDialog({ type: action, id })
              } else void perform({ action, id })
            }}
            events={data.events ?? []}
            comparisonIds={inspector?.type === 'compare' ? comparisonIds : []}
            onCompare={compareSelect}
            onEvent={inspectEvent}
            onHistory={(id) => setInspector({ type: 'history', id })}
            onSnapshot={openSnapshot}
            mergeAvailable={data.capabilities?.merge === true}
            onMerge={(id) => {
              setInspector(null)
              setMergeId(id)
            }}
            onSelect={setSelected}
            onEnter={(id) =>
              id === 'origin' ? close() : void perform({ action: 'start', id }, true)
            }
            onTimeChange={setCursor}
            onFork={openCreate}
            time={time}
            start={earliest}
            end={latest}
          />
        )}
        {data && inspector && !mergeId && (
          <Inspector
            state={inspector}
            lines={all}
            events={data.events ?? []}
            comparisonIds={comparisonIds}
            onComparisonIds={setComparisonIds}
            onEvent={inspectEvent}
            onFork={openCreate}
            onSnapshot={openSnapshot}
            close={() => setInspector(null)}
            api={api}
            busy={!!busy}
          />
        )}
        {mergeId && (
          <MergePanel
            key={mergeId}
            id={mergeId}
            api={api}
            close={() => setMergeId(null)}
            onBusy={(message) => {
              setBusy(message)
              operation.current = !!message
            }}
            onCommitted={() => void refresh()}
          />
        )}
      </div>
      {!!data?.eventWarnings?.length && (
        <p className="wl-event-warning wl-muted" role="status">
          {data.eventWarnings.join('；')}
        </p>
      )}
      {data && (data.lines.length > 0 || data.events?.length > 0) && (
        <TimeControls
          time={time}
          start={earliest}
          end={latest}
          live={cursor === null}
          events={(data.events ?? []).filter((event) => visible.has(event.lineId))}
          onChange={setCursor}
          onNow={() => setCursor(null)}
        />
      )}
      {dialog && (
        <div className="wl-dialog-backdrop">
          <form
            className="wl-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wl-dialog-title"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return
              const elements = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input'),
              )
              const first = elements[0],
                last = elements.at(-1)
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last?.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first?.focus()
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              if (
                busy ||
                (dialog.type !== 'create' && !dialogLine) ||
                (dialog.type !== 'destroy' && aliasError) ||
                (dialog.type === 'destroy' &&
                  deleteConfirmation !== (dialogLine && label(dialogLine)))
              )
                return
              void perform(
                dialog.type === 'create'
                  ? { action: 'create', alias, from: dialog.from, snapshotId: dialog.snapshotId }
                  : dialog.type === 'snapshot'
                    ? { action: 'snapshot', id: dialog.id, label: alias }
                    : dialog.type === 'alias'
                      ? { action: 'alias', id: dialog.id, alias }
                      : { action: 'destroy', id: dialog.id },
              )
            }}
          >
            <div className="wl-header">
              <h2 id="wl-dialog-title">
                {dialog.type === 'create'
                  ? dialog.snapshotId
                    ? '从快照开启世界线'
                    : '开启新的世界线'
                  : dialog.type === 'snapshot'
                    ? '留下一个可返回的起点'
                    : dialog.type === 'alias'
                      ? '修改世界线别名'
                      : '删除世界线'}
              </h2>
              <button
                type="button"
                className="wl-button wl-icon"
                aria-label="关闭"
                disabled={!!busy}
                onClick={() => setDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            {dialog.type === 'create' && (
              <>
                <p>
                  从{' '}
                  <strong>
                    {dialog.from
                      ? label(
                          data?.lines.find((line) => line.id === dialog.from) ?? {
                            ...origin,
                            alias: '来源已不可用',
                          },
                        )
                      : 'main · 正式环境'}
                  </strong>{' '}
                  {dialog.snapshotId
                    ? '的快照配置分支。原世界线继续前行。'
                    : '的当前状态分支。原世界线继续前行。'}
                </p>
                {dialog.at !== undefined && (
                  <p className="wl-muted">
                    定位时间：{new Date(dialog.at).toLocaleString('zh-CN')}
                    {dialog.snapshotId
                      ? '。恢复此快照的插件与配置；会话、模型设置和全局凭据继承来源当前状态。'
                      : '。旁路分支复制当前状态，不恢复历史数据。'}
                  </p>
                )}
                <p className="wl-muted">
                  独立复制配置、会话和账户绑定，继承 API 密钥。登录会话与运行端口保持隔离。
                </p>
              </>
            )}
            {dialog.type === 'snapshot' && (
              <p className="wl-muted">
                为「{dialogLine && label(dialogLine)}
                」保存插件组成与配置。会话、模型设置、全局凭据和本地插件源码不包含在此快照中。配置内的敏感字段会加密保存。
              </p>
            )}
            {dialog.type !== 'destroy' ? (
              <label>
                {dialog.type === 'snapshot' ? '快照名称' : '世界线别名'}
                <input
                  ref={input}
                  value={alias}
                  onChange={(event) => setAlias(event.target.value)}
                  required
                  aria-invalid={!!alias && !!aliasError}
                  aria-describedby="wl-alias-hint"
                  pattern={
                    dialog.type === 'snapshot' ? undefined : '[A-Za-z0-9][A-Za-z0-9_-]{0,63}'
                  }
                  maxLength={dialog.type === 'snapshot' ? 200 : 64}
                  placeholder={
                    dialog.type === 'snapshot' ? '例如 升级 web-login 之前' : '例如 oauth-fix'
                  }
                  disabled={!!busy}
                />
                <span id="wl-alias-hint" className={alias && aliasError ? 'wl-error' : 'wl-muted'}>
                  {busy
                    ? '正在保存，请稍候…'
                    : alias && aliasError
                      ? aliasError
                      : dialog.type === 'snapshot'
                        ? '写下这个时刻的用途，之后更容易找到。'
                        : '唯一名称：字母、数字、下划线或短横线，不能以 lab- 开头。'}
                </span>
              </label>
            ) : (
              <div className="wl-delete-confirm">
                <p>
                  删除「{dialogLine && label(dialogLine)}
                  」及其独立目录。此操作无法撤销，父世界线和子世界线将保留。
                </p>
                <label>
                  输入 {dialogLine && label(dialogLine)} 确认删除
                  <input
                    ref={input}
                    value={deleteConfirmation}
                    onChange={(event) => setDeleteConfirmation(event.target.value)}
                    autoComplete="off"
                    disabled={!!busy}
                  />
                </label>
              </div>
            )}
            {error && (
              <p className="wl-error" role="alert">
                {error}
              </p>
            )}
            {busy && (
              <div className="wl-progress" role="status">
                <CircleNotch className="wl-spin" size={22} />
                <div>
                  <strong>正在准备世界线</strong>
                  <p>{busy}</p>
                  <span className="wl-muted">完成后会自动返回时间轴</span>
                </div>
              </div>
            )}
            <footer>
              <button
                className="wl-button"
                type="button"
                disabled={!!busy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                className="wl-button wl-primary"
                disabled={
                  !!busy ||
                  (dialog.type !== 'create' && !dialogLine) ||
                  (dialog.type !== 'destroy'
                    ? !!aliasError
                    : deleteConfirmation !== (dialogLine && label(dialogLine)))
                }
                type="submit"
              >
                {busy && <CircleNotch size={16} className="wl-spin" />}
                {dialog.type === 'create'
                  ? '创建并启动'
                  : dialog.type === 'snapshot'
                    ? '保存快照'
                    : dialog.type === 'alias'
                      ? '保存别名'
                      : '确认删除'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  )
}
interface Slots {
  inject(name: string, setup: () => unknown): unknown
  register(
    options: { name: string; id: string; order?: number },
    component: (props: { wide?: boolean }) => unknown,
  ): () => void
}
export function apply(ctx: {
  get(name: string): unknown
  effect(setup: () => () => void, label?: string): void
}) {
  const slots = ctx.get('slots') as Slots
  let opened = false
  const listeners = new Set<() => void>()
  const setOpen = (value: boolean) => {
    opened = value
    for (const listener of listeners) listener()
  }
  const useOpen = () => {
    const [value, setValue] = useState(opened)
    useEffect(() => {
      const listener = () => setValue(opened)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }, [])
    return value
  }
  const close = () => setOpen(false)
  function Navigator({ locked }: { locked: boolean }) {
    const open = useOpen()
    const [identity, setIdentity] = useState<{ id: string | null; name: string }>({
      id: null,
      name: 'main',
    })
    const [loadError, setLoadError] = useState(false)
    useEffect(() => {
      let active = true
      const controller = new AbortController()
      const refreshIdentity = async () => {
        try {
          const data: Data = await api(undefined, controller.signal)
          if (active) {
            setIdentity({
              id: data.currentId,
              name: data.currentId
                ? label(
                    data.lines.find((line) => line.id === data.currentId) ??
                      ({ id: data.currentId } as Line),
                  )
                : 'main',
            })
            setLoadError(false)
          }
        } catch {
          if (active) setLoadError(true)
        }
      }
      void refreshIdentity()
      const timer = window.setInterval(() => {
        if (!document.hidden) void refreshIdentity()
      }, 15000)
      return () => {
        active = false
        controller.abort()
        clearInterval(timer)
      }
    }, [])
    const tooltip = `${open ? '返回上一页' : '世界线'} · ${loadError ? '当前位置暂不可用' : identity.id ? `当前：${identity.name}` : '主干 main'}`
    return (
      <div className="wl-corner" data-world-line-entry="true">
        <button
          disabled={locked}
          className="wl-corner-button"
          aria-label={open ? '返回上一页' : '世界线'}
          aria-pressed={open}
          aria-describedby="wl-entry-tooltip"
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M10 5 3 12l7 7M4 12h12a5 5 0 0 1 5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m12 2 9 10-9 10L3 12 12 2Z" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 16 16 7M8 7l9 9M12 4v3m0 10v3" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" />
            </svg>
          )}
        </button>
        {identity.id && (
          <span className="wl-location" title={`当前世界线：${identity.name}`}>
            {identity.name}
          </span>
        )}
        <span id="wl-entry-tooltip" role="tooltip" className="wl-corner-tooltip">
          {tooltip}
        </span>
      </div>
    )
  }
  function Overlay() {
    const open = useOpen()
    const [locked, setLocked] = useState(false)
    return (
      <>
        <Navigator locked={locked} />
        {open && <WorldLine close={close} onBusyChange={setLocked} />}
      </>
    )
  }
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = worldLineFlowCss + styles
    document.head.append(style)
    return () => style.remove()
  }, 'world-line: host theme styles')
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'world-line-page', order: 10 }, Overlay),
  )
}
