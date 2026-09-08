import { access, readFile } from 'node:fs/promises'
import { expect, rs, test } from '@rstest/core'
import { extendedAction } from '../../src/web/extended-actions.js'

const { calls, invoke } = rs.hoisted(() => {
  const calls: any[] = []
  return {
    calls,
    invoke:
      (name: string) =>
      (...args: any[]) => {
        calls.push({ name, args })
        return { requiredFiles: [], name, id: 'session', sourceId: 'selected' }
      },
  }
})
rs.mock('../../src/lab/source.js', () => ({ sourceContext: (ctx: any) => ctx }))
rs.mock('../../src/lab/cache-maintenance.js', () => ({
  migratePackageCache: invoke('migrate'),
  prunePackageCache: invoke('prune'),
}))
rs.mock('../../src/workflows/bisect.js', () => ({
  answerInvestigation: invoke('answer'),
  createInvestigation: invoke('create'),
  listInvestigations: invoke('list'),
  readInvestigation: invoke('show'),
}))
rs.mock('../../src/workflows/investigate-run.js', () => ({
  previewInvestigation: invoke('preview'),
  runInvestigation: invoke('run'),
  skipInterruptedTrial: invoke('skip'),
}))
rs.mock('../../src/workflows/compatibility.js', () => ({ versionMatrix: invoke('matrix') }))
rs.mock('../../src/workflows/portable.js', () => ({
  exportEnvironment: invoke('export'),
  importEnvironment: invoke('import'),
}))
rs.mock('../../src/workflows/deployment.js', () => ({
  activateDeployment: invoke('activate'),
  configureDeployment: invoke('configure'),
  deploymentStatus: invoke('status'),
  rollbackDeployment: invoke('rollback'),
  runDeploymentWatchdog: invoke('watchdog'),
  stageDeployment: invoke('stage'),
}))
rs.mock('../../src/workflows/deployment-service.js', () => ({
  deploymentService: invoke('service'),
}))
rs.mock('../../src/workflows/upgrades.js', () => ({
  checkUpgrades: invoke('check'),
  upgradePolicy: invoke('policy'),
  upgradeResults: invoke('results'),
  upgradeTick: invoke('tick'),
}))

rs.mock('../../src/commands/recovery.js', () => ({
  runRecovery: invoke('recover'),
  reconcilePromotion: invoke('reconcile'),
}))
rs.mock('../../src/commands/lab.js', () => ({
  runLabConfigApply: async (_ctx: any, file: string, options: any) => {
    expect(await readFile(file, 'utf8')).toBe('[]')
    expect(options.keep).toBe(true)
    expect(options.clientProbes).toBe(true)
    options.onProbe({ status: 'pass' })
    options.onLabCreated('lab-fixture')
    calls.push({ name: 'config', args: [file, options] })
    return { ok: true }
  },
}))
const { jobs, pending } = rs.hoisted(() => ({
  jobs: [] as any[],
  pending: [] as Promise<unknown>[],
}))
rs.mock('../../src/web/jobs.js', () => ({
  startJob: (kind: any, run: any, id: any, options: any) => {
    jobs.push({ kind, id, options })
    pending.push(
      Promise.resolve().then(() =>
        run({ setPhase: () => {}, pushProbe: () => {}, setLabId: () => {} }),
      ),
    )
    return { id: 'job-fixture' }
  },
}))
rs.mock('../../src/web/insights.js', () => ({
  lineContext: (ctx: any) => ctx,
  checkedSnapshot: invoke('snapshot'),
  currentManifest: invoke('current'),
  snapshotEvents: invoke('events'),
}))
rs.mock('../../src/lab/manifest.js', () => ({
  readLabManifest: () => ({ source: { profileName: 'web' } }),
}))
test('Web workflow routes keep jobs scoped to the selected source and forward user decisions', async () => {
  const ctx = {
    home: '/tmp/wl-routing',
    cwd: '/tmp/wl-routing',
    profileName: 'web',
    env: {},
    json: true,
    breakStaleLock: false,
    now: () => new Date(),
  }
  const routes: [string, Record<string, unknown>, string][] = [
    ['recovery-list', { id: 'origin' }, 'recover'],
    [
      'recovery-apply',
      {
        id: 'lab-20260908T120000Z-00000001',
        runtimeStopped: true,
        recordId: 'record',
        transaction: true,
      },
      'reconcile',
    ],
    ['recovery-apply', { id: 'origin', runtimeStopped: true, recordId: 'record' }, 'recover'],
    ['lab-config-apply', { sourceId: 'selected', text: '[]', interactive: true }, 'config'],
    ['cache-prune', { runtimeStopped: true }, 'prune'],
    ['cache-migrate', { id: 'lab' }, 'migrate'],
    ['deployment-status', {}, 'service'],
    ['deployment-stage', { id: 'lab-fixture' }, 'stage'],
    ['deployment-activate', { id: 'slot' }, 'activate'],
    ['deployment-rollback', {}, 'rollback'],
    ['deployment-config', { enabled: true, threshold: 4 }, 'configure'],
    ['deployment-service', { operation: 'stop', breakStale: true }, 'service'],
    ['version-matrix', { sourceId: 'selected', versions: ['0.1.2'] }, 'matrix'],
    ['upgrade-results', {}, 'results'],
    ['upgrade-policy', { id: 'selected', enabled: true, hours: 12 }, 'policy'],
    ['upgrade-check', { id: 'selected' }, 'check'],
    ['environment-export', { id: 'selected', snapshotId: 'snap' }, 'export'],
    ['environment-import', { sourceId: 'selected', bundleText: '{}', requiredFiles: {} }, 'import'],
    ['investigations', {}, 'list'],
    ['investigation-create', { kind: 'plugins', sourceId: 'selected' }, 'create'],
    ['investigation-run', { id: 'session', automatic: true }, 'run'],
    ['investigation-preview', { id: 'session' }, 'preview'],
    ['investigation-answer', { id: 'session', revision: 4, verdict: 'bad' }, 'answer'],
    ['investigation-skip-interrupted', { id: 'session', breakStale: true }, 'skip'],
    ['snapshot-list', { id: 'selected' }, 'events'],
  ]
  for (const [action, body, name] of routes) {
    const result = await extendedAction(ctx, { action, ...body })
    await Promise.all(pending)
    expect(result.handled).toBe(true)
    expect(calls.at(-1)?.name).toBe(name)
  }
  expect(
    jobs
      .filter((j) =>
        ['version-matrix', 'upgrade-check', 'environment-import', 'investigate'].includes(j.kind),
      )
      .every((j) => j.options.resource === 'selected'),
  ).toBe(true)
  await expect(access(calls.find((c) => c.name === 'config').args[0])).rejects.toThrow()
  await expect(extendedAction(ctx, { action: 'recovery-apply', id: 'origin' })).rejects.toThrow(
    '停止',
  )
  expect(calls.find((c) => c.name === 'answer').args.slice(1)).toEqual(['session', 4, 'bad'])
  expect(calls.find((c) => c.name === 'skip').args[0].breakStaleLock).toBe(true)
  expect(calls.find((c) => c.name === 'matrix').args.slice(1, 3)).toEqual([['0.1.2'], 'selected'])
  await expect(
    extendedAction(ctx, { action: 'deployment-service', operation: 'destroy' }),
  ).rejects.toThrow('无效')
  await expect(
    extendedAction(ctx, { action: 'investigation-create', kind: 'unknown' }),
  ).rejects.toThrow('无效')
  expect(await extendedAction(ctx, { action: 'unknown' })).toEqual({ handled: false })
})
