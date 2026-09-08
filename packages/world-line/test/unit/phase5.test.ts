import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { redactData } from '../../src/domain/redact-data.js'
import { withOperations } from '../../src/fs/operation.js'
import {
  gcApply,
  gcPreview,
  gcPurge,
  gcRestore,
  storageUsage,
} from '../../src/vault/maintenance.js'
import { putObject } from '../../src/vault/objects.js'
import { validateAction } from '../../src/web/action-schema.js'
import { getJob, listJobs, startJob } from '../../src/web/jobs.js'
import { mapLimited, ReadCache } from '../../src/web/read-cache.js'

async function temp(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'wl-phase5-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
async function terminal(id: string) {
  for (let n = 0; n < 200; n++) {
    const j = getJob(id)
    if (j && !['running', 'queued'].includes(j.status)) return j
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('job timeout')
}
describe('Phase 5 contracts', () => {
  test('schemas reject unknown fields, inherited action names and invalid booleans', () => {
    expect(() => validateAction({ action: 'lab-update', spec: 'a@1', keep: 'true' })).toThrow()
    expect(() => validateAction({ action: 'constructor' })).toThrow()
    expect(() => validateAction({ action: 'composition', id: 'origin', home: '/tmp' })).toThrow()
    expect(validateAction({ action: 'lab-config-apply', text: 'x'.repeat(65536) })).toBe(
      'lab-config-apply',
    )
  })
  test('redaction preserves JSON keys and string boundaries', () => {
    const data = redactData({ error: 'token=secret-value', next: { id: 'safe' } })
    expect(data.next.id).toBe('safe')
    expect(data.error).not.toContain('secret-value')
    expect(JSON.parse(JSON.stringify(data)).next.id).toBe('safe')
  })
  test('same resource queues while independent sources progress, durable profile scoping', () =>
    temp(async (home) => {
      const scope = { home, profileName: 'web', resource: 'origin' }
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const first = startJob('lab-update', () => gate, undefined, scope)
      const next = startJob('lab-remove', async () => ({ ok: true }), undefined, scope)
      const independent = startJob('restore', async () => ({ ok: true }), undefined, {
        ...scope,
        resource: 'lab-20260907T120000Z-abcdef12',
      })
      expect(getJob(next.id)?.status).toBe('queued')
      expect((await terminal(independent.id)).status).toBe('ok')
      expect(getJob(first.id, { home, profileName: 'other' })).toBeUndefined()
      release()
      await terminal(first.id)
      expect((await terminal(next.id)).status).toBe('ok')
      const stored = JSON.parse(
        await readFile(join(home, 'world-line', 'jobs', `${next.id}.json`), 'utf8'),
      )
      expect(stored.status).toBe('ok')
      expect(listJobs(scope)).toHaveLength(3)
    }))
  test('dead process records become interrupted without executing a mutation', () =>
    temp(async (home) => {
      await mkdir(join(home, 'world-line', 'jobs'), { recursive: true })
      const id = 'job-orphan'
      await writeFile(
        join(home, 'world-line', 'jobs', `${id}.json`),
        JSON.stringify({
          id,
          schemaVersion: 1,
          kind: 'promote',
          profileName: 'web',
          status: 'running',
          phase: '',
          probes: [],
          startedAt: new Date().toISOString(),
          ownerPid: 2147483647,
          ownerHost: hostname(),
        }),
      )
      expect(getJob(id, { home, profileName: 'web' })?.status).toBe('interrupted')
    }))
  test('operation locks are reentrant but exclude another asynchronous operation', () =>
    temp(async (home) => {
      let release!: () => void
      let entered!: () => void
      const ready = new Promise<void>((r) => {
        entered = r
      })
      const held = withOperations([home], 'web', async () => {
        await withOperations([home], 'web', async () => {})
        entered()
        await new Promise<void>((r) => {
          release = r
        })
      })
      await ready
      await expect(withOperations([home], 'web', async () => {})).rejects.toThrow()
      release()
      await held
    }))
  test('object collection checks revision, quarantines, restores and enforces delay', () =>
    temp(async (home) => {
      await putObject(home, Buffer.from('orphan'))
      const plan = await gcPreview(home)
      expect(plan.objects).toHaveLength(1)
      await expect(gcApply(home, 'stale')).rejects.toThrow('重新预览')
      const result = await gcApply(home, plan.revision)
      expect((await gcPreview(home)).objects).toHaveLength(0)
      await expect(gcPurge(home, result.id)).rejects.toThrow('7 天')
      expect((await gcRestore(home, result.id)).restored).toBe(1)
      expect((await gcPreview(home)).objects).toHaveLength(1)
    }))
  test('corrupt manifests and unknown objects stop GC', () =>
    temp(async (home) => {
      await putObject(home, Buffer.from('orphan'))
      await mkdir(join(home, 'world-line', 'vault', 'snapshots'), { recursive: true })
      await writeFile(join(home, 'world-line', 'vault', 'snapshots', 'snap-bad.json'), '{broken')
      await expect(gcPreview(home)).rejects.toThrow('损坏')
    }))
  test('disk scan deduplicates hardlinks and does not follow symlinks', () =>
    temp(async (home) => {
      await mkdir(join(home, 'world-line', 'data'), { recursive: true })
      const a = join(home, 'world-line', 'data', 'a')
      await writeFile(a, '12345678')
      await link(a, join(home, 'world-line', 'data', 'b'))
      await symlink('/etc', join(home, 'world-line', 'external'))
      const size = await storageUsage(home)
      expect(size.logicalBytes).toBe(8)
      expect(size.files).toBe(1)
    }))
  for (const count of [100, 1000])
    test(`cached reads and bounded concurrency for ${count} records`, () =>
      temp(async (home) => {
        const cache = new ReadCache()
        const path = join(home, 'manifest')
        await writeFile(path, '1')
        let calls = 0,
          active = 0,
          peak = 0
        const ids = Array.from({ length: count }, (_, i) => i)
        const read = async (i: number) =>
          cache.read(String(i), [path], async () => {
            calls++
            active++
            peak = Math.max(peak, active)
            await Promise.resolve()
            active--
            return i
          })
        await mapLimited(ids, 6, read)
        await mapLimited(ids, 6, read)
        expect(calls).toBe(count)
        expect(peak).toBeLessThanOrEqual(6)
        await writeFile(path, 'changed')
        await read(0)
        expect(calls).toBe(count + 1)
      }))
})

import { assertCoreRows, parseComposedTreeText } from '../../src/lab/compose.js'

test('bundle provenance follows parsed mapping positions, ignoring marker text in scalars', () => {
  const baseline = parseComposedTreeText(
    '# == core\n- id: a\n  text: |\n    # == forged\n# == addon\n- id: b\n',
    'fixture',
  )
  expect(baseline.rows.map((r) => r.sourceBundle)).toEqual(['core', 'addon'])
  expect(() => assertCoreRows(baseline, baseline, new Set(['core']))).not.toThrow()
  const missing = parseComposedTreeText('# == addon\n- id: b\n', 'fixture')
  expect(() => assertCoreRows(missing, baseline, new Set(['core']))).toThrow('core row a')
  const disabled = parseComposedTreeText('# == core\n- id: a\n  disabled: true\n', 'fixture')
  expect(() => assertCoreRows(disabled, baseline, new Set(['core']))).toThrow()
  expect(parseComposedTreeText('- id: a\n', 'fixture').rows[0]?.sourceBundle).toBeUndefined()
})

import { jobEvents } from '../../src/web/job-events.js'

test('SSE replay advances cursors, avoids duplicate states and resets an unknown cursor', () =>
  temp(async (home) => {
    const scope = { home, profileName: 'web', resource: 'origin' }
    const initial = jobEvents(scope)
    expect(JSON.parse(initial[0]!.data)).toEqual([])
    expect(jobEvents(scope, initial[0]!.id)).toEqual([])
    const job = startJob('lab-add', async () => ({ ok: true }), undefined, scope)
    await terminal(job.id)
    const replay = jobEvents(scope, initial[0]!.id)
    expect(replay).toHaveLength(1)
    expect(JSON.parse(replay[0]!.data)[0].status).toBe('ok')
    expect(jobEvents(scope, 'old-server-cursor')[0]!.id).toBe(replay[0]!.id)
    expect(JSON.parse(jobEvents({ ...scope, profileName: 'other' })[0]!.data)).toEqual([])
  }))

import { revisionResponse } from '../../src/web/revisions.js'

test('world revisions send only changed rows and deletion markers, unknown revisions reset', () => {
  const key = 'revision-fixture',
    a = {
      lines: [
        { id: 'a', state: 'running' },
        { id: 'b', state: 'stopped' },
      ],
      events: [],
      now: '1',
    }
  const initial = revisionResponse(key, a) as any
  expect(revisionResponse(key, { ...a, now: '2' }, initial.revision)).toMatchObject({
    unchanged: true,
  })
  const changed = revisionResponse(
    key,
    { ...a, lines: [{ id: 'a', state: 'stopped' }], now: '3' },
    initial.revision,
  ) as any
  expect(changed.delta.lines).toEqual({ upsert: [{ id: 'a', state: 'stopped' }], remove: ['b'] })
  expect(revisionResponse(key, a, 'old')).toMatchObject({ lines: a.lines })
})

import { runSnapshotCreate } from '../../src/commands/snapshot.js'
import { gcRecords } from '../../src/vault/maintenance.js'
import { readSnapshotManifest } from '../../src/vault/manifests.js'
import { readObject } from '../../src/vault/objects.js'
import { writeProfile } from '../helpers/fixture.js'

test('GC preserves snapshot files and homePatch while quarantining only an orphan', () =>
  temp(async (home) => {
    await writeProfile(home, 'web')
    await writeFile(join(home, 'cordis.patch.yml'), '- id: sample\n  config:\n    color: blue\n')
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: {},
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const snapshot = await runSnapshotCreate(ctx, { label: 'gc fixture' }),
      manifest = await readSnapshotManifest(home, snapshot.id)
    expect(manifest.homePatch?.object).toBeTruthy()
    await putObject(home, Buffer.from('orphan-only'))
    const plan = await gcPreview(home)
    expect(plan.objects).toHaveLength(1)
    const result = await gcApply(home, plan.revision)
    expect(await readObject(home, manifest.homePatch!.object!)).toBeInstanceOf(Buffer)
    for (const file of manifest.files)
      if (file.object) expect(await readObject(home, file.object)).toBeInstanceOf(Buffer)
    expect((await gcRecords(home))[0]).toMatchObject({
      id: result.id,
      remaining: 1,
      canPurge: false,
    })
    await gcRestore(home, result.id)
    expect((await gcRecords(home))[0]?.remaining).toBe(0)
  }))
test('GC rejects object symlinks and missing recovery roots', () =>
  temp(async (home) => {
    await mkdir(join(home, 'world-line', 'vault', 'objects'), { recursive: true })
    const path = join(home, 'world-line', 'vault', 'objects', 'a'.repeat(64))
    await symlink('/etc/hosts', path)
    await expect(gcPreview(home)).rejects.toThrow('非普通文件')
    await rm(path)
    await writeFile(
      join(home, 'world-line', 'state.json'),
      JSON.stringify({
        formatVersion: 1,
        lastSnapshots: { web: 'snap-missing' },
        lastKnownGood: {},
      }),
    )
    await expect(gcPreview(home)).rejects.toThrow('恢复快照引用')
  }))
