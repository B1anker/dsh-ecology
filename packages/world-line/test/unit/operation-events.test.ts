import { expect, test } from '@rstest/core'
import { eventMarkers, type Line } from '../../src/client/timeline-model.js'
import type { WorldEvent } from '../../src/domain/insight-types.js'
import type { PromotionJournalEntry } from '../../src/lab/journal.js'
import type { LabManifest } from '../../src/lab/manifest.js'
import { projectOperations } from '../../src/web/operation-events.js'

test('one installation owns only its linked backups, retaining package version and committed outcome', () => {
  const events: WorldEvent[] = ['baseline', 'before', 'after', 'manual'].map((id, index) => ({
    id,
    snapshotId: id,
    lineId: 'login',
    kind: 'snapshot',
    title: id,
    detail: '',
    at: new Date(1000 + index * 1000).toISOString(),
  }))
  const lab = {
    id: 'lab',
    purpose: 'verification',
    state: 'failed',
    source: { parentLabId: 'login', baselineSnapshotId: 'baseline' },
    plan: [{ action: 'add', id: '@scope/plugin', spec: '@scope/plugin@0.6.0' }],
    createdAt: new Date(1000).toISOString(),
  } as unknown as LabManifest
  const entry = {
    id: 'transaction',
    labId: 'lab',
    kind: 'promotion',
    outcome: 'committed',
    preSnapshot: 'before',
    afterSnapshot: 'after',
    createdAt: new Date(2000).toISOString(),
  } as PromotionJournalEntry
  projectOperations(events, [lab], [entry, entry])
  const operation = events.find((event) => event.kind === 'operation')!
  expect(operation.title).toBe('安装 @scope/plugin 0.6.0 · 已应用')
  expect(operation.childEventIds).toEqual(['baseline', 'before', 'after'])
  expect(events.find((event) => event.id === 'manual')?.parentEventId).toBeUndefined()
  const line = { id: 'login', createdAt: new Date(0).toISOString() } as Line
  expect(
    eventMarkers(events, line, 0, 10000)
      .flatMap((marker) => marker.events)
      .map((event) => event.id),
  ).toEqual([operation.id, 'manual'])
  expect(
    eventMarkers(events, line, 0, 10000, undefined, ['before'])
      .flatMap((marker) => marker.events)
      .some((event) => event.id === 'before'),
  ).toBe(true)
})
