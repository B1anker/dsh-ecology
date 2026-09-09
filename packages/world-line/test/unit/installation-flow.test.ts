import { expect, test } from '@rstest/core'
import { installationToResume } from '../../src/client/installation-flow.js'
import { currentJobAction, type Job } from '../../src/client/job-view.js'

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'a',
  resource: 'branch-a',
  kind: 'lab-add',
  status: 'running',
  phase: '安装依赖',
  probes: [],
  startedAt: '2026-09-08T08:00:00Z',
  ...overrides,
})
test('installation belongs to the selected source, never another branch or an unscoped old job', () => {
  expect(installationToResume([job(), job({ resource: undefined })], 'branch-b')).toBeNull()
  expect(installationToResume([job()], 'branch-a')?.id).toBe('a')
})
test('queued, running, login and review steps resume rather than creating another lab', () => {
  for (const status of ['queued', 'running', 'awaiting_auth', 'review', 'incomplete'] as const)
    expect(installationToResume([job({ status })], 'branch-a')?.id).toBe('a')
})
test('verification still awaits merge; completed promotion and failed terminal jobs start fresh', () => {
  expect(installationToResume([job({ status: 'ok' })], 'branch-a')?.id).toBe('a')
  for (const ended of [
    job({ status: 'ok', kind: 'promote' }),
    job({ status: 'ok', result: { promoted: true } }),
    job({ status: 'fail' }),
    job({ status: 'error' }),
    job({ status: 'interrupted' }),
  ])
    expect(installationToResume([ended], 'branch-a')).toBeNull()
})
test('a completed merge supersedes old verification; current work takes precedence over older receipts', () => {
  const verified = job({ status: 'ok' })
  const merged = job({ id: 'b', kind: 'promote', status: 'ok', startedAt: '2026-09-08T09:00:00Z' })
  expect(installationToResume([verified, merged], 'branch-a')).toBeNull()
  expect(
    installationToResume(
      [verified, merged, job({ id: 'c', startedAt: '2026-09-08T10:00:00Z' })],
      'branch-a',
    )?.id,
  ).toBe('c')
})

test('the active task row exposes the server phase instead of a generic loading label', () => {
  expect(currentJobAction(job({ phase: '正在检查插件依赖和配置组合' }))).toBe(
    '正在检查插件依赖和配置组合',
  )
  expect(currentJobAction(job({ phase: '', status: 'queued' }))).toContain('等待同一环境')
})

test('internal promotion phase ids are rendered as user-facing actions', () => {
  expect(currentJobAction(job({ phase: 'gate' }))).toBe('检查合入条件')
  expect(currentJobAction(job({ phase: 'swap' }))).toBe('将已验证配置合入来源环境')
})
