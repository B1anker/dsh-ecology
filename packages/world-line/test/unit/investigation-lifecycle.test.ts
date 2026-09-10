import { expect, rs, test } from '@rstest/core'
import {
  answerInvestigation,
  createInvestigation,
  type Investigation,
  listInvestigations,
  readInvestigation,
  saveInvestigation,
} from '../../src/workflows/bisect.js'
import {
  previewInvestigation,
  runInvestigation,
  skipInterruptedTrial,
} from '../../src/workflows/investigate-run.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

const { restore, start } = rs.hoisted(() => ({ restore: rs.fn(), start: rs.fn() }))
rs.mock('../../src/commands/restore.js', () => ({ runRestoreCommand: restore }))
rs.mock('../../src/commands/lab-service.js', () => ({ runLabStart: start }))
const handle = {
  id: 'trial-job',
  kind: 'investigate' as const,
  setPhase: rs.fn(),
  setLabId: rs.fn(),
  pushProbe: rs.fn(),
  setTransactionId: rs.fn(),
}
test('investigation persists trial evidence, demands verdicts and never replays an interrupted trial', async () => {
  const home = await makeTempHome()
  try {
    const bin = await installFakeDsh(home)
    await writeProfile(home, 'web', {
      packageJson: JSON.stringify({ dependencies: { 'fixture-a': '1.0.0', 'fixture-b': '1.0.0' } }),
    })
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: { PATH: bin },
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const s = await createInvestigation(ctx, 'plugins')
    expect((await listInvestigations(ctx)).length).toBe(1)
    restore.mockImplementation(async (_ctx, options) => {
      await options.onLabCreated('lab-20260908T120000Z-00000001')
      options.onProbe({ check: 'fixture', status: 'pass' })
      return { ok: true, clientGate: 'passed' }
    })
    let state: Investigation = await runInvestigation(ctx, s.id, handle)
    expect(state.status).toBe('review')
    expect(state.active?.suggested).toBe('good')
    await expect(runInvestigation(ctx, s.id, handle)).rejects.toThrow('判断')
    start.mockResolvedValue({ id: 'lab-20260908T120000Z-00000002', ok: true })
    await previewInvestigation(ctx, s.id)
    await previewInvestigation(ctx, s.id)
    expect(start.mock.calls.at(-1)?.[1]).toEqual({ id: 'lab-20260908T120000Z-00000002' })
    state = await readInvestigation(ctx, s.id)
    await expect(answerInvestigation(ctx, s.id, state.revision - 1, 'good')).rejects.toThrow()
    await answerInvestigation(ctx, s.id, state.revision, 'good')
    restore.mockRejectedValue(new Error('probe unavailable'))
    state = await runInvestigation(ctx, s.id, handle)
    expect(state.active?.suggested).toBe('skip')
    expect(state).toMatchObject({ ok: false, active: { error: 'probe unavailable' } })
    state.status = 'running'
    await saveInvestigation(ctx, state)
    const calls = restore.mock.calls.length
    await expect(runInvestigation(ctx, s.id, handle)).rejects.toThrow('未结算')
    await skipInterruptedTrial(ctx, s.id)
    expect(restore.mock.calls.length).toBe(calls)
    await expect(skipInterruptedTrial(ctx, s.id)).rejects.toThrow('没有中断')
    await expect(previewInvestigation(ctx, s.id)).rejects.toThrow('完成')
    const another = await createInvestigation(ctx, 'plugins')
    restore.mockResolvedValue({ ok: false, clientGate: 'inconclusive' })
    const ended = await runInvestigation(ctx, another.id, handle, true)
    expect(['complete', 'inconclusive']).toContain(ended.status)
    expect(ended.ok).toBe(ended.status === 'complete')

    const broken = await createInvestigation(ctx, 'plugins')
    restore.mockImplementation(async (_ctx, options) => {
      options.onProbe({ check: 'plugin-remove', status: 'fail', detail: 'Unknown options' })
      return { ok: false, clientGate: 'skipped' }
    })
    const before = restore.mock.calls.length
    const failed = await runInvestigation(ctx, broken.id, handle, true)
    expect(restore.mock.calls.length).toBe(before + 1)
    expect(failed).toMatchObject({
      ok: false,
      status: 'review',
      trials: [],
      active: {
        suggested: 'skip',
        error: '实验环境准备失败：Unknown options',
      },
    })
    expect((await readInvestigation(ctx, broken.id)).active?.error).toBe(failed.active?.error)

    // A functioning experiment that reproduces the problem is valid evidence.
    const reproduced = await createInvestigation(ctx, 'plugins')
    restore.mockImplementation(async (_ctx, options) => {
      options.onProbe({ check: 'plugin-function', status: 'fail' })
      return { ok: false, clientGate: 'fail' }
    })
    expect(await runInvestigation(ctx, reproduced.id, handle)).toMatchObject({
      ok: true,
      active: { suggested: 'bad' },
    })
  } finally {
    await destroyTempHome(home)
  }
})
