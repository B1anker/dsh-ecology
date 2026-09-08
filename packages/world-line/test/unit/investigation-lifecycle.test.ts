import { expect, rs, test } from '@rstest/core'
import {
  answerInvestigation,
  createInvestigation,
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
    let state = await runInvestigation(ctx, s.id, handle)
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
  } finally {
    await destroyTempHome(home)
  }
})
