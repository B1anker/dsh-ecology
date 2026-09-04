/**
 * Transaction orchestrator tests (`runLabTransaction`) against a fabricated
 * lab in a temp home, with injected capture/launch/httpGet fakes — the full
 * protocol: candidate step argv + lab env (DSH_HOME/WORLD_LINE_LAB), compose
 * dump, host boot, HTTP ready, verdict persistence, default cleanup vs
 * --keep, and failure retention.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import type { CliContext } from '../../src/context.js'
import type { KnownHost } from '../../src/lab/gate.js'
import {
  labDir,
  labHomeDir,
  labManifestPath,
  labProbePath,
  labProfileDir,
  newLabId,
} from '../../src/lab/layout.js'
import type { LabManifest, LabPlanRecord } from '../../src/lab/manifest.js'
import { readLabManifest } from '../../src/lab/manifest.js'
import type { LabRunDeps } from '../../src/lab/run.js'
import { runLabTransaction } from '../../src/lab/run.js'
import {
  destroyTempHome,
  makeTempHome,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const HOST: KnownHost = {
  binary: { path: '/fixture/dsh' },
  version: { raw: '0.1.2-rc.1', core: { major: 0, minor: 1, patch: 2 }, prerelease: 'rc.1' },
  adapterId: 'dsh-0.1.x',
  raw: '0.1.2-rc.1',
}

const CLEAN_DUMP = `- id: alpha
  name: '@x/alpha'
- id: beta
  name: '@x/beta'
`

function makeCtx(home: string, now: () => Date): CliContext {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
    home,
    profileName: 'web',
    json: false,
    breakStaleLock: false,
    now,
  }
}

async function fabricateLab(home: string, now: Date): Promise<{ labId: string }> {
  const profileDir = join(home, 'profiles', 'web')
  await writeProfile(home, 'web', {
    packageJson: profilePackageJson({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    }),
  })
  await mkdir(profileDir, { recursive: true })
  const labId = newLabId(now)
  const target = labProfileDir(home, labId, 'web')
  await mkdir(target, { recursive: true })
  await writeFile(
    join(target, 'package.json'),
    await readFile(join(profileDir, 'package.json')),
    'utf8',
  )
  await writeFile(join(target, 'cordis.patch.yml'), '[]\n', 'utf8')
  await writeFile(join(target, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
  const manifest: LabManifest = {
    manifestVersion: 1,
    id: labId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    adapterId: 'dsh-0.1.x',
    dshVersion: '0.1.2-rc.1',
    runtime: { nodeVersion: 'v24', os: 'x', arch: 'y' },
    source: { profileName: 'web', receipt: '00'.repeat(32) },
    state: 'created',
    runCount: 0,
    plan: [],
    retention: { cleanupMode: 'keep-on-failure' },
  }
  await writeFile(labManifestPath(home, labId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { labId }
}

const ADD_PLAN: LabPlanRecord[] = [
  { seq: 1, action: 'add', id: '@fixture/probe', spec: '@fixture/probe@1.0.0' },
]

interface FakeRecorder {
  pluginArgs: string[][]
  dumpArgs: string[][]
  envs: NodeJS.ProcessEnv[]
  stopped: number
}

function makeDeps(recorder: FakeRecorder): {
  deps: LabRunDeps
  behavior: { pluginExit?: number; dumpExit?: number }
} {
  const behavior = { pluginExit: 0, dumpExit: 0 }
  const deps: LabRunDeps = {
    capture: async (file, args, options) => {
      recorder.envs.push({ ...options.env })
      const text = [...args]
      if (text.includes('--dump-config')) {
        recorder.dumpArgs.push([...args])
        return {
          exitCode: behavior.dumpExit,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: behavior.dumpExit === 0 ? CLEAN_DUMP : '',
          stderr: behavior.dumpExit === 0 ? '' : 'compose exploded',
        }
      }
      recorder.pluginArgs.push([...args])
      return {
        exitCode: behavior.pluginExit,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: 'Done',
        stderr: '',
      }
    },
    launch: async (options) => {
      if (options.env.DSH_HOME === undefined) {
        return { kind: 'spawn-error', detail: 'no DSH_HOME passed to the launch' }
      }
      return {
        kind: 'ready',
        detail: 'ready',
        handle: {
          pid: 4242,
          url: 'http://127.0.0.1:51999/?token=abc',
          port: 51999,
          stop: async () => {
            recorder.stopped += 1
            return { exitCode: 0, signal: null, stdout: '', stderr: '' }
          },
        },
      }
    },
    httpGet: async () => ({ status: 200 }),
  }
  return { deps, behavior }
}

async function expectManifestGone(home: string, labId: string): Promise<void> {
  await expect(readLabManifest(home, labId)).rejects.toThrow(/no manifest/)
}

describe('runLabTransaction protocol', () => {
  test('happy path passes all probes and cleans up by default', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const recorder: FakeRecorder = { pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 }
      const { deps } = makeDeps(recorder)
      const outcome = await runLabTransaction({
        ctx: makeCtx(home, () => now),
        host: HOST,
        labId,
        plan: ADD_PLAN,
        deps,
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.deleted).toBe(true)
      expect(outcome.port).toBe(51999)
      expect(recorder.pluginArgs).toEqual([
        [
          'plugin',
          '--profile',
          'web',
          'add',
          '@fixture/probe@1.0.0',
          '--store-dir',
          join(labDir(home, labId), 'pnpm-store'),
          '--ignore-scripts',
        ],
      ])
      expect(recorder.dumpArgs).toEqual([['--profile', 'web', '--dump-config']])
      const env = recorder.envs[0] ?? {}
      expect(env.DSH_HOME).toBe(labHomeDir(home, labId))
      expect(env.WORLD_LINE_LAB).toBe(labId)
      expect(recorder.stopped).toBe(1)
      await expectManifestGone(home, labId)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('--keep retains a passed lab with probe.json and retention notes', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const recorder: FakeRecorder = { pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 }
      const { deps } = makeDeps(recorder)
      const outcome = await runLabTransaction({
        ctx: makeCtx(home, () => now),
        host: HOST,
        labId,
        plan: ADD_PLAN,
        keep: true,
        deps,
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.deleted).toBe(false)
      const manifest = await readLabManifest(home, labId)
      expect(manifest.state).toBe('passed')
      expect(manifest.retention.cleanupMode).toBe('keep-on-failure')
      expect(manifest.runCount).toBe(1)
      expect(manifest.lastRun?.ok).toBe(true)
      expect(manifest.lastRun?.port).toBe(51999)
      const probeJson = JSON.parse(await readFile(labProbePath(home, labId), 'utf8')) as {
        probes: { check: string; status: string }[]
      }
      const checks = probeJson.probes.map((entry) => `${entry.check}:${entry.status}`)
      expect(checks).toEqual(
        expect.arrayContaining([
          'plugin-add:pass',
          'compose:pass',
          'host-boot:pass',
          'http-ready:pass',
        ]),
      )
    } finally {
      await destroyTempHome(home)
    }
  })

  test('failing candidate step keeps the lab 7 days with state failed', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const recorder: FakeRecorder = { pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 }
      const { deps, behavior } = makeDeps(recorder)
      behavior.pluginExit = 7
      const outcome = await runLabTransaction({
        ctx: makeCtx(home, () => now),
        host: HOST,
        labId,
        plan: ADD_PLAN,
        deps,
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.deleted).toBe(false)
      expect(recorder.dumpArgs).toEqual([]) // compose never ran
      const manifest = await readLabManifest(home, labId)
      expect(manifest.state).toBe('failed')
      expect(manifest.retention.expiresAt).toBe('2026-09-11T10:00:00.000Z')
      expect(manifest.lastRun?.ok).toBe(false)
      const probeJson = JSON.parse(await readFile(labProbePath(home, labId), 'utf8')) as {
        probes: { status: string }[]
      }
      expect(probeJson.probes.some((entry) => entry.status === 'fail')).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('boot failure fails the run and stops no phantom processes', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const recorder: FakeRecorder = { pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 }
      const { deps } = makeDeps(recorder)
      deps.launch = async () => ({ kind: 'timeout', detail: 'no ready line within 120000 ms' })
      const outcome = await runLabTransaction({
        ctx: makeCtx(home, () => now),
        host: HOST,
        labId,
        plan: ADD_PLAN,
        deps,
      })
      expect(outcome.ok).toBe(false)
      expect(recorder.stopped).toBe(0)
      const manifest = await readLabManifest(home, labId)
      expect(manifest.state).toBe('failed')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('config-apply run passes the overlay to the compose dump', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const overlayPath = join(labDir(home, labId), 'config-apply.yml')
      await writeFile(overlayPath, '- insert:\n    - id: extra\n      name: extra-svc\n', 'utf8')
      const recorder: FakeRecorder = { pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 }
      const { deps } = makeDeps(recorder)
      const outcome = await runLabTransaction({
        ctx: makeCtx(home, () => now),
        host: HOST,
        labId,
        plan: [{ seq: 1, action: 'config-apply', overlayPath }],
        keep: true,
        deps,
      })
      expect(outcome.ok).toBe(true)
      expect(recorder.pluginArgs).toEqual([])
      expect(recorder.dumpArgs).toEqual([
        ['--profile', 'web', '--dump-config', '--patch', overlayPath],
      ])
      await expect(readLabManifest(home, labId)).resolves.toMatchObject({ state: 'passed' })
    } finally {
      await destroyTempHome(home)
    }
  })

  test('refuses mid-run and destroyed labs', async () => {
    const home = await makeTempHome()
    try {
      const now = new Date('2026-09-04T10:00:00.000Z')
      const { labId } = await fabricateLab(home, now)
      const manifestPath = labManifestPath(home, labId)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LabManifest
      manifest.state = 'applying'
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      const { deps } = makeDeps({ pluginArgs: [], dumpArgs: [], envs: [], stopped: 0 })
      await expect(
        runLabTransaction({
          ctx: makeCtx(home, () => now),
          host: HOST,
          labId,
          plan: ADD_PLAN,
          deps,
        }),
      ).rejects.toThrow(/mid-run/)
      manifest.state = 'destroyed'
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await expect(
        runLabTransaction({
          ctx: makeCtx(home, () => now),
          host: HOST,
          labId,
          plan: ADD_PLAN,
          deps,
        }),
      ).rejects.toThrow(/destroyed/)
    } finally {
      await destroyTempHome(home)
    }
  })
})
