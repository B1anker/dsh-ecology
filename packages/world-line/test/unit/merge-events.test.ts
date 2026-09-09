import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import type { WorldEvent } from '../../src/domain/insight-types.js'
import { projectMerges } from '../../src/web/merge-events.js'

test('completed merges become named nodes and own only the target backup; old records still work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wl-merge-events-'))
  try {
    const row = {
      id: 'merge-ab12',
      profileName: 'web',
      committed: true,
      sourceId: 'login',
      sourceName: 'login',
      targetId: 'origin',
      targetName: 'main',
      plugins: ['@scope/plugin', '@scope/local'],
      labId: 'lab-20260909T085848Z-5044b30c',
      includeConfig: true,
      preSnapshot: 'before',
    }
    for (const candidate of [
      row,
      { ...row, id: 'merge-ab13', committed: false },
      { ...row, id: 'merge-ab14', profileName: 'other' },
    ]) {
      const dir = join(home, 'world-line/merges', candidate.id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'candidate.json'), JSON.stringify(candidate))
    }
    const profile = join(home, 'world-line/labs', row.labId, 'home/profiles/web')
    await mkdir(profile, { recursive: true })
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: { '@scope/plugin': '0.6.0', '@scope/local': 'file:frozen' } }),
    )
    const hash = createHash('sha256').update('dependencies:@scope/local').digest('hex').slice(0, 16)
    const frozen = join(home, 'world-line/merges', row.id, 'packages', hash)
    await mkdir(frozen, { recursive: true })
    await writeFile(
      join(frozen, 'package.json'),
      JSON.stringify({ name: '@scope/local', version: '0.1.0' }),
    )
    const events: WorldEvent[] = ['origin', 'login'].map((lineId) => ({
      id: `${lineId}:before`,
      lineId,
      kind: 'snapshot',
      at: '2026-09-09T08:59:56Z',
      snapshotId: 'before',
      title: '合入前：login',
      detail: '',
    }))
    await projectMerges({ home, profileName: 'web' } as CliContext, events)
    const merges = events.filter((event) => event.kind === 'merge')
    expect(merges).toHaveLength(1)
    expect(merges[0]).toMatchObject({
      title: 'login → main · 合入完成',
      sourceLineId: 'login',
      lineId: 'origin',
      childEventIds: ['origin:before'],
      packages: [
        { name: '@scope/plugin', version: '0.6.0' },
        { name: '@scope/local', version: '0.1.0' },
      ],
    })
    expect(Number.isFinite(Date.parse(merges[0]!.at))).toBe(true)
    expect(events[0]!.parentEventId).toBe(merges[0]!.id)
    expect(events[1]!.parentEventId).toBeUndefined()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
