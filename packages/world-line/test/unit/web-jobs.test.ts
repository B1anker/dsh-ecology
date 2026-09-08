/**
 * Job registry tests (`src/web/jobs.ts`): lifecycle and probe/phase
 * accumulation, the single-flight guard across mutating kinds, business
 * failure vs thrown error, and redaction of captured error text.
 */

import { describe, expect, test } from '@rstest/core'

import { UsageError } from '../../src/domain/errors.js'
import type { ProbeResult } from '../../src/domain/probe.js'
import { getJob, startJob } from '../../src/web/jobs.js'

function probe(check: string, status: ProbeResult['status'] = 'pass'): ProbeResult {
  return {
    check,
    label: `${check} label`,
    required: true,
    startedAt: '2026-09-04T10:00:00.000Z',
    finishedAt: '2026-09-04T10:00:01.000Z',
    status,
  }
}

async function waitForTerminal(id: string): Promise<NonNullable<ReturnType<typeof getJob>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = getJob(id)
    if (job !== undefined && job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`job ${id} never reached a terminal state`)
}

describe('web job registry', () => {
  test('a resolving runner lands ok with its result, phases and probe ladder', async () => {
    const job = startJob('lab-add', (handle) => {
      handle.setPhase('verify')
      handle.pushProbe(probe('compose'))
      handle.pushProbe(probe('host-boot'))
      return Promise.resolve({ ok: true, labId: 'lab-x' })
    })
    expect(job.id).toMatch(/^job-/)
    expect(job.kind).toBe('lab-add')
    const done = await waitForTerminal(job.id)
    expect(done.status).toBe('ok')
    expect(done.phase).toBe('verify')
    expect(done.probes.map((entry) => entry.check)).toEqual(['compose', 'host-boot'])
    expect(done.result).toEqual({ ok: true, labId: 'lab-x' })
    expect(typeof done.startedAt).toBe('string')
    expect(typeof done.finishedAt).toBe('string')
    // Snapshots are copies: mutating one does not reach the registry.
    done.probes.push(probe('forged'))
    expect(getJob(job.id)?.probes).toHaveLength(2)
  })

  test('a runner resolving ok:false is a business fail, not an error', async () => {
    const job = startJob('restore', () => Promise.resolve({ ok: false, kind: 'verify' }))
    const done = await waitForTerminal(job.id)
    expect(done.status).toBe('fail')
    expect(done.error).toBeUndefined()
    expect(done.result).toMatchObject({ ok: false })
  })

  test('a second start while one job runs is refused', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const job = startJob('promote', () => gate.then(() => ({ ok: true })))
    expect(() => startJob('lab-add', () => Promise.resolve({}))).toThrow(UsageError)
    expect(() => startJob('restore', () => Promise.resolve({}))).toThrow('已有验证任务进行中')
    release()
    const done = await waitForTerminal(job.id)
    expect(done.status).toBe('ok')
    // Once finished, the next job starts normally.
    const next = startJob('lab-add', () => Promise.resolve({ ok: true }))
    expect((await waitForTerminal(next.id)).status).toBe('ok')
  })

  test('a throwing runner lands error with the message redacted', async () => {
    const job = startJob('lab-add', () =>
      Promise.reject(new Error('boot failed with token=deadbeefcafe in the environment')),
    )
    const done = await waitForTerminal(job.id)
    expect(done.status).toBe('error')
    expect(done.error).toContain('<redacted>')
    expect(done.error).not.toContain('deadbeefcafe')
    expect(done.result).toBeUndefined()
  })

  test('unknown ids poll as undefined', () => {
    expect(getJob('job-does-not-exist')).toBeUndefined()
  })
})

test('an unsuccessful merge retains its experiment identity for recovery', async () => {
  const job = startJob(
    'promote',
    async () => {
      throw new Error('需要补做浏览器验证')
    },
    'lab-retained',
  )
  const done = await waitForTerminal(job.id)
  expect(done.status).toBe('error')
  expect(done.labId).toBe('lab-retained')
})
