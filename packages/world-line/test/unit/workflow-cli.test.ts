import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, rs, test } from '@rstest/core'
import { workflowCli } from '../../src/workflows/cli.js'

const { calls, invoke } = rs.hoisted(() => {
  const calls: any[] = []
  return {
    calls,
    invoke:
      (name: string) =>
      (...args: any[]) => {
        calls.push({ name, args })
        return { requiredFiles: [], name }
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
test('workflow CLI preserves confirmation requirements and dispatches source and revision parameters', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wl-cli-workflow-'))
  const ctx = {
    home,
    cwd: home,
    profileName: 'web',
    env: {},
    json: true,
    breakStaleLock: false,
    now: () => new Date(),
  }
  try {
    for (const [command, args] of [
      ['cache', ['prune']],
      ['matrix', ['0.1.2']],
      ['import', ['file']],
      ['deployment', ['activate', 'slot']],
      ['upgrade', ['check']],
    ] as const) {
      const n = calls.length
      await expect(workflowCli(ctx, command, [...args])).rejects.toThrow('--yes')
      expect(calls.length).toBe(n)
    }
    const routes: [string, string[], string][] = [
      ['cache', ['prune', '--yes'], 'prune'],
      ['cache', ['migrate', 'lab', '--yes'], 'migrate'],
      ['matrix', ['0.1.2', '--yes'], 'matrix'],
      ['investigate', ['list'], 'list'],
      ['investigate', ['create', 'plugins', '--source', 'line'], 'create'],
      ['investigate', ['show', 'session'], 'show'],
      ['investigate', ['preview', 'session'], 'preview'],
      ['investigate', ['run', 'session', '--automatic'], 'run'],
      ['investigate', ['answer', 'session', 'skip', '--revision', '4'], 'answer'],
      ['investigate', ['skip-interrupted', 'session', '--yes'], 'skip'],
      ['upgrade', ['results'], 'results'],
      ['upgrade', ['check', '--yes'], 'check'],
      ['upgrade', ['policy'], 'policy'],
      ['upgrade', ['policy', '--enabled', '--hours', '12', '--yes'], 'policy'],
      ['deployment', ['status'], 'status'],
      ['deployment', ['stage', 'lab', '--yes'], 'stage'],
      ['deployment', ['activate', 'slot', '--yes'], 'activate'],
      ['deployment', ['rollback', '--yes'], 'rollback'],
      ['deployment', ['config', '--enabled', '--threshold', '4', '--yes'], 'configure'],
      ['deployment', ['start', '--yes'], 'service'],
      ['deployment', ['stop', '--yes'], 'service'],
      ['deployment', ['run', '--yes'], 'watchdog'],
    ]
    for (const [command, args, name] of routes) {
      await workflowCli(ctx, command, args)
      expect(calls.at(-1)?.name).toBe(name)
    }
    expect(calls.find((c) => c.name === 'answer').args.slice(1)).toEqual(['session', 4, 'skip'])
    const output = join(home, 'bundle.json')
    await workflowCli(ctx, 'export', ['snap', '--output', output])
    expect(JSON.parse(await readFile(output, 'utf8')).name).toBe('export')
    const secrets = join(home, 'private.json')
    await writeFile(secrets, '{}')
    await workflowCli(ctx, 'import', [output, '--yes', '--required-files', secrets])
    expect(calls.at(-1)?.name).toBe('import')
    for (const [command, args] of [
      ['cache', ['bad', '--yes']],
      ['export', []],
      ['import', ['--yes']],
      ['investigate', ['create', 'invalid']],
      ['investigate', ['show']],
      ['investigate', ['answer', 'id']],
      ['unknown', []],
      ['matrix', ['--source']],
    ] as [string, string[]][])
      await expect(workflowCli(ctx, command, args)).rejects.toThrow()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
