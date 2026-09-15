/**
 * The client doubles a workspace-sidebar plugin binds to — `sessions.list`,
 * `workspaces`, `uiWorkspace`, `locale` — and the host-side `connection`
 * fence. Each test pins the behaviour a consumer relies on; a change here is a
 * change to what a dependent plugin's tests are allowed to assume.
 */

import { expect, test } from '@rstest/core'
import {
  createMockClientContext,
  createMockClientRuntime,
  createMockLocale,
  createMockSessions,
  createMockWorkspaces,
} from '../src/client.js'
import { createMockConnection } from '../src/connection.js'
import { fakeRequest } from '../src/http.js'

test('sessions.list reports the current session and setCurrent notifies', () => {
  const sessions = createMockSessions(null, 's-1')
  expect(sessions.list.getSnapshot()).toEqual({ current: 's-1' })

  const seen: (string | undefined)[] = []
  sessions.list.subscribe(() => seen.push(sessions.list.getSnapshot().current))
  sessions.setCurrent('s-2')
  sessions.setCurrent(undefined)
  expect(seen).toEqual(['s-2', undefined])
  expect(sessions.list.getSnapshot()).toEqual({})
})

test('sessions.binding answers for bound faces and bumps the list on bind/unbind', () => {
  const sessions = createMockSessions<null, { running: boolean }>(null, 's-1')
  let listRevisions = 0
  sessions.list.subscribe(() => {
    listRevisions += 1
  })
  expect(sessions.binding?.('s-1')).toBeUndefined()

  const face = sessions.bind('s-1', { running: false })
  const bound = sessions.binding?.('s-1')
  expect(bound?.sessionId).toBe('s-1')
  expect(bound?.session).toBe(face)
  face.set({ running: true })
  expect(bound?.session.getSnapshot()).toEqual({ running: true })

  sessions.unbind('s-1')
  expect(sessions.binding?.('s-1')).toBeUndefined()
  expect(listRevisions).toBe(2)
})

test('the sessions shape option hides the surface the other host generation lacks', () => {
  const legacy = createMockSessions(null, undefined, 'provide-info')
  expect(legacy.currentProvideInfo).toBeDefined()
  expect(legacy.binding).toBeUndefined()

  const current = createMockSessions(null, undefined, 'binding')
  expect(current.currentProvideInfo).toBeUndefined()
  expect(typeof current.binding).toBe('function')

  const runtime = createMockClientRuntime({ sessionsShape: 'binding' })
  expect(runtime.sessions.currentProvideInfo).toBeUndefined()
})

test('workspaces create appends a row, delete removes it, both are recorded', async () => {
  const workspaces = createMockWorkspaces([{ workspaceId: 'ws-1', path: '/repo' }])
  let notified = 0
  workspaces.list.subscribe(() => {
    notified += 1
  })

  const created = await workspaces.create({ path: '/repo/.worktrees/feature' })
  expect(created).toEqual({ workspaceId: 'ws-2', path: '/repo/.worktrees/feature' })
  expect(workspaces.list.getSnapshot().items.map((item) => item.workspaceId)).toEqual([
    'ws-1',
    'ws-2',
  ])

  await workspaces.delete('ws-1')
  expect(workspaces.list.getSnapshot().items.map((item) => item.workspaceId)).toEqual(['ws-2'])
  await expect(workspaces.delete('missing')).rejects.toThrow(/unknown workspace/)

  expect(workspaces.created).toEqual([{ path: '/repo/.worktrees/feature' }])
  expect(workspaces.deleted).toEqual(['ws-1', 'missing'])
  expect(notified).toBe(2)
})

test('locale binds a namespace, interpolates params, and falls back by language then en', () => {
  const locale = createMockLocale('zh-CN')
  const dispose = locale.register('worktree', {
    en: { create: 'Create worktree for {branch}', onlyEn: 'English only' },
    zh: { create: '为 {branch} 创建 worktree' },
  })
  const t = locale.bind('worktree')

  expect(t('create', { branch: 'main' })).toBe('为 main 创建 worktree')
  expect(t('onlyEn')).toBe('English only')
  expect(t('missing')).toBe('missing')
  // An unknown placeholder is left in place rather than blanked.
  expect(t('create')).toBe('为 {branch} 创建 worktree')

  let notified = 0
  locale.subscribe(() => {
    notified += 1
  })
  locale.setActive('en')
  expect(locale.getSnapshot()).toEqual({ active: 'en' })
  expect(t('create', { branch: 'main' })).toBe('Create worktree for main')
  expect(notified).toBe(1)

  dispose()
  expect(t('create')).toBe('create')
})

test('locale register merges a second dictionary into the same namespace', () => {
  const locale = createMockLocale()
  locale.register('ns', { en: { a: 'A' } })
  locale.register('ns', { en: { b: 'B' }, zh: { a: '甲' } })
  const t = locale.bind('ns')
  expect([t('a'), t('b')]).toEqual(['A', 'B'])
  expect(locale.dictionaries.get('ns')).toEqual({ en: { a: 'A', b: 'B' }, zh: { a: '甲' } })
})

test('the runtime publishes every double under the name the shell uses', () => {
  const runtime = createMockClientRuntime({
    currentSessionId: 's-9',
    workspaces: [{ workspaceId: 'ws-1', path: '/repo' }],
    locale: 'zh-CN',
    services: { extra: 42 },
  })
  expect(runtime.context.get('sessions')).toBe(runtime.sessions)
  expect(runtime.context.get('workspaces')).toBe(runtime.workspaces)
  expect(runtime.context.get('uiWorkspace')).toBe(runtime.uiWorkspace)
  expect(runtime.context.get('locale')).toBe(runtime.locale)
  expect(runtime.context.get('slots')).toBe(runtime.slots)
  expect(runtime.context.get('settingsScope')).toBe(runtime.settingsScope)
  expect(runtime.context.get('extra')).toBe(42)
  expect(runtime.sessions.list.getSnapshot().current).toBe('s-9')
  expect(runtime.workspaces.list.getSnapshot().items).toHaveLength(1)
  expect(runtime.locale.getSnapshot().active).toBe('zh-CN')

  runtime.uiWorkspace.startSession('s-9')
  expect(runtime.uiWorkspace.started).toEqual(['s-9'])
})

test('the client context runs effects at once and disposes them in reverse', () => {
  const ctx = createMockClientContext({})
  const order: string[] = []
  ctx.effect(() => {
    order.push('setup-a')
    return () => order.push('teardown-a')
  }, 'a')
  ctx.effect(() => {
    order.push('setup-b')
    return () => order.push('teardown-b')
  })
  // A setup without a teardown is fine, and so is a setup that throws: the
  // error reaches the test instead of being swallowed by a recorder.
  ctx.effect(() => {
    order.push('setup-c')
  })
  expect(() =>
    ctx.effect(() => {
      throw new Error('mount failed')
    }),
  ).toThrow('mount failed')

  expect(order).toEqual(['setup-a', 'setup-b', 'setup-c'])
  expect(ctx.teardowns.map((entry) => entry.label)).toEqual(['a', undefined])
  ctx.dispose()
  expect(order.slice(3)).toEqual(['teardown-b', 'teardown-a'])
  expect(ctx.teardowns).toHaveLength(0)
})

test('the connection double accepts by default and rejects per the installed policy', () => {
  const connection = createMockConnection()
  const anonymous = fakeRequest({ headers: {} })
  expect(connection.requestRejection(anonymous)).toBeUndefined()

  connection.rejectWhen((request) => (request.headers.cookie === undefined ? 401 : undefined))
  expect(connection.requestRejection(anonymous)).toBe(401)
  expect(connection.requestRejection(fakeRequest({ headers: { cookie: 'dsh_session=x' } }))).toBe(
    undefined,
  )

  expect(connection.consulted.map((entry) => entry.rejection)).toEqual([undefined, 401, undefined])
})
