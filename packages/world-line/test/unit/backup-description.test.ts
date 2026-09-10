import { expect, test } from '@rstest/core'
import { backupDescription } from '../../src/client/backup-description.js'
import type { WorldEvent } from '../../src/domain/insight-types.js'

const point: WorldEvent = {
  id: 'origin:s1',
  snapshotId: 's1',
  lineId: 'origin',
  at: '2026-09-10T00:00:00Z',
  kind: 'snapshot',
  title: '安装插件前',
  detail: '',
}
const installation: WorldEvent = {
  id: 'install',
  lineId: 'origin',
  at: point.at,
  kind: 'operation',
  actionLabel: '安装插件',
  packageLabel: '@example/plugin 1.2.3',
  title: '安装 @example/plugin 1.2.3 · 已完成',
  detail: '',
  childEventIds: [point.id],
}

test('installation backup identifies the explicitly linked plugin and version', () => {
  const result = backupDescription(point, [installation])
  expect(result.label).toContain('@example/plugin 1.2.3')
  expect(result.operations[0]?.title).toBe(installation.title)
  expect(result.label).not.toMatch(/前|后/)
})
test('same timestamp cannot attribute an unrelated install or invent a version', () => {
  const result = backupDescription(point, [{ ...installation, childEventIds: ['other'] }])
  expect(result.label).toContain('未记录插件和版本')
  expect(result.operations).toEqual([])
})
test('identically named snapshot from another environment cannot supply the operation', () => {
  expect(backupDescription(point, [{ ...installation, lineId: 'other' }]).operations).toEqual([])
})
test('a saved name stable cannot imply a passed health check', () => {
  const result = backupDescription({ ...point, title: 'stable' }, [])
  expect(result.label).toBe('命名备份 · stable')
  expect(result.explanation).toContain('不是验证结果')
})
test('diagnostic capture explains its purpose without declaring it healthy', () => {
  const result = backupDescription({ ...point, title: '插件排障基线' }, [])
  expect(result.label).toBe('插件排查 · 自动保存的环境')
  expect(result.explanation).toContain('为复现问题')
  expect(result.label).not.toMatch(/前|后|基线/)
})
