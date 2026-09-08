import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import { reconcilePromotion } from '../../src/commands/recovery.js'
import { sha256Hex } from '../../src/fs/hash.js'
import { listTransactions, readTransaction } from '../../src/lab/transaction.js'
import { readSnapshotManifest } from '../../src/vault/manifests.js'
import { recoveryReferences } from '../../src/vault/references.js'
import { readState, writeState } from '../../src/vault/state.js'
import { getJob } from '../../src/web/jobs.js'
/**
 * Phase 3 promote module tests: the client gate (§6), the receipt conflict
 * guard, the auto pre/post-promote snapshots, the atomic whitelist swap, the
 * journal, and the optional restart verification with atomic rollback.
 * The browser layer is faked: no network, no chromium, no dsh spawns.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import { UsageError, VerificationError } from '../../src/domain/errors.js'
import { probe } from '../../src/domain/probe.js'
import { analyzeProfile } from '../../src/domain/snapshot.js'
import { adapterDsh01x } from '../../src/host-adapters/dsh-0.1.x.js'
import { journalPath } from '../../src/lab/journal.js'
import {
  labHomeDir,
  labManifestPath,
  labProbePath,
  labProfileDir,
  newLabId,
} from '../../src/lab/layout.js'
import type { LabManifest } from '../../src/lab/manifest.js'
import { classifyClientGate, runLabPromote } from '../../src/lab/promote.js'
import { lastKnownGoodFor } from '../../src/vault/state.js'
import {
  destroyTempHome,
  installFakeDsh,
  makeTempHome,
  minimalLockfile,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const WHITELIST = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml']

function makeCtx(home: string, now: () => Date, fakeBin: string): CliContext {
  return {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    home,
    profileName: 'web',
    json: false,
    breakStaleLock: false,
    now,
  }
}

interface Seed {
  ctx: CliContext
  labId: string
  officialDir: string
}

async function seedPassedLab(
  home: string,
  now: () => Date,
  fakeBin: string,
  probes: Parameters<typeof classifyClientGate>[0],
  receipt?: string,
  options: { officialLockfile?: boolean } = {},
): Promise<Seed> {
  const nowDate = now()
  await writeProfile(home, 'web', {
    packageJson: profilePackageJson({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    }),
    ...(options.officialLockfile !== false
      ? { lockfile: minimalLockfile('@deepseek-ai/dsh-base', '0.1.0') }
      : {}),
  })
  const officialDir = join(home, 'profiles', 'web')
  const analysis = await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
  const labId = newLabId(nowDate)
  const target = labProfileDir(home, labId, 'web')
  await mkdir(target, { recursive: true })
  const labDir = join(home, 'world-line', 'labs', labId)
  await mkdir(labDir, { recursive: true })
  for (const name of WHITELIST) {
    try {
      const content = await readFile(join(officialDir, name))
      await writeFile(join(target, name), content, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const manifest: LabManifest = {
    manifestVersion: 1,
    id: labId,
    createdAt: nowDate.toISOString(),
    updatedAt: nowDate.toISOString(),
    adapterId: 'dsh-0.1.x',
    dshVersion: '0.1.2-rc.1',
    runtime: { nodeVersion: 'v24', os: 'x', arch: 'y' },
    source: { profileName: 'web', receipt: receipt ?? analysis.receipt.tree },
    state: 'passed',
    runCount: 1,
    plan: [{ seq: 1, action: 'add', id: '@fixture/cand', spec: '@fixture/cand@1.0.0' }],
    retention: { cleanupMode: 'keep-on-failure' },
  }
  await writeFile(labManifestPath(home, labId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const probeJson = `${JSON.stringify({ probes }, null, 2)}\n`
  await writeFile(join(labDir, 'probe.json'), probeJson, 'utf8')
  return { ctx: makeCtx(home, now, fakeBin), labId, officialDir }
}

const READY_PROBES = [
  probe(new Date('2026-09-04T00:00:00.000Z'), 'browser-boot', 'boots', 'pass'),
  probe(new Date('2026-09-04T00:00:00.000Z'), 'core-contract', 'core', 'pass'),
  probe(new Date('2026-09-04T00:00:00.000Z'), 'candidate-contract', 'candidate', 'pass'),
]

describe('client gate classification', () => {
  test('pass requires a passed browser-boot and no fails', () => {
    const bootOnly = READY_PROBES.find((entry) => entry.check === 'browser-boot')
    const coreOnly = READY_PROBES.find((entry) => entry.check === 'core-contract')
    expect(classifyClientGate(READY_PROBES)).toBe('pass')
    expect(classifyClientGate(bootOnly === undefined ? [] : [bootOnly])).toBe('inconclusive')
    expect(classifyClientGate(coreOnly === undefined ? [] : [coreOnly])).toBe('inconclusive')
  })

  test('any client fail is a hard fail', () => {
    const fail = probe(new Date(), 'browser-boot', 'boots', 'fail', { detail: 'boom' })
    expect(classifyClientGate([...READY_PROBES.slice(1), fail])).toBe('fail')
    expect(classifyClientGate([fail])).toBe('fail')
  })

  test('missing, skipped, and inconclusive evidence are inconclusive', () => {
    expect(classifyClientGate([])).toBe('inconclusive')
    expect(classifyClientGate([probe(new Date(), 'browser-boot', 'x', 'skip')])).toBe(
      'inconclusive',
    )
    expect(classifyClientGate([probe(new Date(), 'browser-boot', 'x', 'inconclusive')])).toBe(
      'inconclusive',
    )
  })
})

describe('lab promote', () => {
  test('promotes with committed journal, pre/after snapshots and lab content', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
      // Mutate the lab so the swap is observable.
      const labPackage = join(labProfileDir(home, labId, 'web'), 'package.json')
      const labText = await readFile(labPackage, 'utf8')
      await writeFile(
        labPackage,
        labText.replace('"dependencies": {', '"dependencies": {\n    "@fixture/cand": "1.0.0",'),
        'utf8',
      )

      const result = await runLabPromote(ctx, { labId })

      expect(result.ok).toBe(true)
      expect(result.clientGate).toBe('pass')
      expect(result.appliedFiles.sort()).toEqual(WHITELIST.slice().sort())
      expect(result.restartVerified).toBe(false)
      const officialText = await readFile(join(officialDir, 'package.json'), 'utf8')
      expect(officialText).toContain('@fixture/cand')
      expect(officialText).toContain('@deepseek-ai/dsh-web-app')

      const journal = await readFile(journalPath(home), 'utf8')
      const entries = journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'promotion',
        outcome: 'committed',
        labId,
        preSnapshot: result.preSnapshot,
        afterSnapshot: result.afterSnapshot,
        lastKnownGood: false,
      })
      expect(entries[0].files.sort()).toEqual(WHITELIST.slice().sort())
      expect(await lastKnownGoodFor(home, 'web')).toBeNull()
    } finally {
      await destroyTempHome(home)
    }
  })

  test('refuses a client-failed lab even with --accept-inconclusive', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const failProbes = [
        probe(new Date('2026-09-04T12:00:00.000Z'), 'browser-boot', 'x', 'fail', {
          detail: 'console errors',
        }),
      ]
      const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, failProbes)
      const officialBefore = await readFile(join(officialDir, 'package.json'), 'utf8')
      await expect(runLabPromote(ctx, { labId, acceptInconclusive: true })).rejects.toBeInstanceOf(
        VerificationError,
      )
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(officialBefore)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('refuses inconclusive evidence without --accept-inconclusive', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId } = await seedPassedLab(home, now, fakeBin, [])
      await expect(runLabPromote(ctx, { labId })).rejects.toBeInstanceOf(VerificationError)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('missing critical evidence cannot be bypassed with --accept-inconclusive', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId } = await seedPassedLab(home, now, fakeBin, [])
      await expect(runLabPromote(ctx, { labId, acceptInconclusive: true })).rejects.toBeInstanceOf(
        VerificationError,
      )
    } finally {
      await destroyTempHome(home)
    }
  })

  test('refuses when the official receipt drifted from the lab source receipt', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId, officialDir } = await seedPassedLab(
        home,
        now,
        fakeBin,
        READY_PROBES,
        'aa'.repeat(32),
      )
      const before = await readFile(join(officialDir, 'package.json'), 'utf8')
      await expect(runLabPromote(ctx, { labId })).rejects.toBeInstanceOf(UsageError)
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(before)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('restart verification failure rolls the official files back and journals it', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
      const officialBefore = await readFile(join(officialDir, 'package.json'), 'utf8')
      const labPackage = join(labProfileDir(home, labId, 'web'), 'package.json')
      await writeFile(
        labPackage,
        (await readFile(labPackage, 'utf8')).replace(
          '"dependencies": {',
          '"dependencies": {\n    "@fixture/cand": "1.0.0",',
        ),
        'utf8',
      )
      const launchFake = async () => ({ kind: 'spawn-error' as const, detail: 'boom' })
      await expect(
        runLabPromote(ctx, { labId, restart: true, deps: { launch: launchFake } }),
      ).rejects.toThrow(/rolled back/)
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(officialBefore)
      const entries = (await readFile(journalPath(home), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(entries[0]).toMatchObject({
        outcome: 'rolled-back',
        reason: expect.stringContaining('did not boot after promote'),
      })
      expect(await lastKnownGoodFor(home, 'web')).toBeNull()
    } finally {
      await destroyTempHome(home)
    }
  })

  test('restart verification pass marks the after-snapshot lastKnownGood', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
      const labPackage = join(labProfileDir(home, labId, 'web'), 'package.json')
      await writeFile(
        labPackage,
        (await readFile(labPackage, 'utf8')).replace(
          '"dependencies": {',
          '"dependencies": {\n    "@fixture/cand": "1.0.0",',
        ),
        'utf8',
      )
      ctx.env.WL_ENV_TEST = 'official'
      ctx.experimentEnv = { ...ctx.env, WL_ENV_TEST: 'experiment', DSH_HOME: '/wrong' }
      const launchFake: NonNullable<
        NonNullable<Parameters<typeof runLabPromote>[1]['deps']>['launch']
      > = async (options) => {
        expect(options.env.WL_ENV_TEST).toBe('official')
        expect(options.env.DSH_HOME).toBe(home)
        return {
          kind: 'ready' as const,
          handle: {
            pid: 1,
            url: 'http://127.0.0.1:9/',
            port: 9,
            stop: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
          },
          detail: '',
        }
      }
      const clientProbeFake = async () => ({
        signal: {
          kind: 'ready' as const,
          state: {
            mountChildren: 1,
            buttons: ['新会话'],
            roles: ['tree'],
            bodyHas: ['工作区'],
            bootGlobals: ['__DSH_BOOT__'],
            bootEntries: 1,
          },
          settledMs: 5,
        },
        events: [],
      })
      const result = await runLabPromote(ctx, {
        labId,
        restart: true,
        deps: {
          launch: launchFake,
          clientProbe: clientProbeFake,
          install: async () => {
            await writeFile(
              join(officialDir, 'package.json'),
              (await readFile(join(officialDir, 'package.json'), 'utf8')) + '\n\n',
            )
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              spawnError: null,
              stdout: '',
              stderr: '',
            }
          },
        },
      })
      const after = await readSnapshotManifest(home, result.afterSnapshot!)
      expect(after.files.find((file) => file.name === 'package.json')?.sha256).toBe(
        sha256Hex(await readFile(join(officialDir, 'package.json'))),
      )
      expect(result.restartVerified).toBe(true)
      expect(result.lastKnownGood).toBe(result.afterSnapshot)
      expect(await lastKnownGoodFor(home, 'web')).toBe(result.afterSnapshot)
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toContain('@fixture/cand')
      const entries = (await readFile(journalPath(home), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(entries[0]).toMatchObject({ outcome: 'committed', lastKnownGood: true })
    } finally {
      await destroyTempHome(home)
    }
  })

  test('rollback deletes managed files the promote introduced', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      // Official profile has NO lockfile; the lab gained one during its run
      // (like a pnpm add), so the promote introduces pnpm-lock.yaml.
      const { ctx, labId, officialDir } = await seedPassedLab(
        home,
        now,
        fakeBin,
        READY_PROBES,
        undefined,
        {
          officialLockfile: false,
        },
      )
      const labLock = join(labProfileDir(home, labId, 'web'), 'pnpm-lock.yaml')
      await writeFile(labLock, minimalLockfile('@deepseek-ai/dsh-base', '0.1.0'), 'utf8')
      const labPackage = join(labProfileDir(home, labId, 'web'), 'package.json')
      await writeFile(
        labPackage,
        (await readFile(labPackage, 'utf8')).replace(
          '"dependencies": {',
          '"dependencies": {\n    "@fixture/cand": "1.0.0",',
        ),
        'utf8',
      )
      const launchFake = async () => ({ kind: 'spawn-error' as const, detail: 'boom' })
      await expect(
        runLabPromote(ctx, { labId, restart: true, deps: { launch: launchFake } }),
      ).rejects.toThrow(/rolled back/)
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).not.toContain(
        '@fixture/cand',
      )
      await expect(readFile(join(officialDir, 'pnpm-lock.yaml'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      const entries = (await readFile(journalPath(home), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(entries[0]).toMatchObject({ outcome: 'rolled-back' })
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('branch-backed verification', () => {
  for (const drift of [false, true])
    test(`promotion targets the source branch, drift=${drift}`, async () => {
      const home = await makeTempHome()
      try {
        const fakeBin = await installFakeDsh(home)
        const now = () => new Date('2026-09-04T12:00:00.000Z')
        const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
        const parentId = newLabId(new Date('2026-09-04T10:00:00.000Z'))
        const { labHomeDir } = await import('../../src/lab/layout.js')
        const parentHome = labHomeDir(home, parentId)
        await writeProfile(parentHome, 'web', {
          packageJson: profilePackageJson({ bundles: ['@fixture/branch-only'] }),
        })
        const childManifest = JSON.parse(
          await readFile(labManifestPath(home, labId), 'utf8'),
        ) as LabManifest
        await writeFile(
          labManifestPath(home, parentId),
          JSON.stringify({ ...childManifest, id: parentId, purpose: 'mirror' }),
        )
        const { sourceContext } = await import('../../src/lab/source.js')
        const { createLab } = await import('../../src/lab/create.js')
        const { requireKnownHost } = await import('../../src/lab/gate.js')
        const source = await sourceContext(ctx, parentId)
        const clone = await createLab(ctx, requireKnownHost(ctx), 'web', {
          sourceHome: source.home,
          parentLabId: parentId,
        })
        expect(clone.manifest.source.parentLabId).toBe(parentId)
        expect(await readFile(join(clone.labProfileDir, 'package.json'), 'utf8')).toContain(
          '@fixture/branch-only',
        )
        childManifest.source = { ...clone.manifest.source }
        await writeFile(labManifestPath(home, labId), JSON.stringify(childManifest))
        const parentPackage = join(parentHome, 'profiles/web/package.json')
        const originalMain = await readFile(join(officialDir, 'package.json'), 'utf8')
        const originalBranch = await readFile(parentPackage, 'utf8')
        await writeFile(
          join(labProfileDir(home, labId, 'web'), 'package.json'),
          originalBranch.replace(
            '"dependencies": {',
            '"dependencies": {\n "@fixture/cand": "1.0.0",',
          ),
        )
        if (drift) {
          await writeFile(
            parentPackage,
            originalBranch.replace('@fixture/branch-only', '@fixture/changed'),
          )
          await expect(runLabPromote(ctx, { labId })).rejects.toThrow('receipt mismatch')
          expect(await readFile(parentPackage, 'utf8')).toContain('@fixture/changed')
        } else {
          const result = await runLabPromote(ctx, { labId })
          expect(result.ok).toBe(true)
          expect(await readFile(parentPackage, 'utf8')).toContain('@fixture/cand')
          expect(await readFile(parentPackage, 'utf8')).toContain('@fixture/branch-only')
          expect(await readFile(journalPath(home), 'utf8')).toContain(labId)
        }
        expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(originalMain)
      } finally {
        await destroyTempHome(home)
      }
    })
})

describe('promotion crash recovery', () => {
  test('unknown writes block rollback and malformed records block reference collection', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const { ctx, labId, officialDir } = await seedPassedLab(
        home,
        () => new Date('2026-09-04T12:00:00.000Z'),
        fakeBin,
        READY_PROBES,
      )
      ctx.env.WORLD_LINE_DISABLE_KEYCHAIN = '1'
      const edited = (await readFile(join(officialDir, 'package.json'), 'utf8')) + '\n\n\n'
      await expect(
        runLabPromote(ctx, {
          labId,
          onPhase: (phase) => {
            if (phase === 'swapped') {
              writeFileSync(join(officialDir, 'package.json'), edited)
              throw new Error('external edit')
            }
          },
        }),
      ).rejects.toThrow('recovery incomplete')
      const record = (await listTransactions(home))[0]!
      await expect(reconcilePromotion(ctx, record.id)).rejects.toThrow('conflict')
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(edited)
      expect(
        await readFile(
          join(home, 'world-line', 'transactions', record.id, 'backup', 'package.json'),
          'utf8',
        ),
      ).not.toBe(edited)
      await writeFile(
        join(home, 'world-line', 'transactions', record.id, 'record.json'),
        JSON.stringify({ ...record, version: 99 }),
      )
      await expect(recoveryReferences(home)).rejects.toThrow('恢复引用')
    } finally {
      await destroyTempHome(home)
    }
  })

  for (const phase of [
    'swapping',
    'swapped',
    'installing',
    'verifying',
    'verified',
    'snapshotted',
    'committing',
    'committed',
  ]) {
    test(`SIGKILL at ${phase} reconciles without replaying plugin commands`, async () => {
      const home = await makeTempHome()
      try {
        const fakeBin = await installFakeDsh(home)
        const now = () => new Date('2026-09-04T12:00:00.000Z')
        const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
        ctx.env.WORLD_LINE_DISABLE_KEYCHAIN = '1'
        const original = await readFile(join(officialDir, 'package.json'), 'utf8')
        const candidate = original + '\n'
        await writeFile(join(labProfileDir(home, labId, 'web'), 'package.json'), candidate)
        const script = `
          const { runLabPromote } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/lab/promote.js')).href)});
          await runLabPromote({ home: ${JSON.stringify(home)}, cwd: process.cwd(), profileName: 'web', env: process.env, json: false, breakStaleLock: false, now: () => new Date('2026-09-04T12:00:00.000Z') }, {
            labId: ${JSON.stringify(labId)}, restart: ${['installing', 'verifying', 'snapshotted', 'committing', 'committed'].includes(phase)},
            deps: {
              install: async () => ({ exitCode: 0, signal: null, timedOut: false, spawnError: null, stdout: '', stderr: '' }),
              launch: async () => ({ kind: 'ready', detail: 'fixture', handle: { pid: 999999, url: 'http://127.0.0.1:9/', port: 9, stop: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }) } }),
              clientProbe: async () => ({ signal: { kind: 'ready', state: { mountChildren: 1, buttons: [], roles: [], bodyHas: [], bootGlobals: [], bootEntries: 1 }, settledMs: 5 }, events: [] }),
            }, onPhase: phase => { if (phase === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); }
          });
        `
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          env: ctx.env,
          encoding: 'utf8',
          timeout: 15000,
        })
        expect(child.signal, child.stderr).toBe('SIGKILL')
        const record = (await listTransactions(home))[0]!
        expect(record.phase).toBe(phase)
        expect((await recoveryReferences(home)).has(record.preSnapshot)).toBe(true)
        const committed = phase === 'committing' || phase === 'committed'
        if (['installing', 'verifying'].includes(phase))
          await expect(
            reconcilePromotion({ ...ctx, breakStaleLock: true }, record.id),
          ).rejects.toThrow('runtime-stopped')
        const result = await reconcilePromotion({ ...ctx, breakStaleLock: true }, record.id, true)
        expect(result.outcome).toBe(committed ? 'committed' : 'rolled-back')
        expect(await lastKnownGoodFor(home, 'web')).toBe(committed ? record.afterSnapshot : null)
        expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(
          committed ? candidate : original,
        )
        expect((await readState(home)).lastSnapshots.web).toBe(
          committed ? record.afterSnapshot : record.preSnapshot,
        )
        const lines = (await readFile(journalPath(home), 'utf8')).trim().split('\n')
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0]!).outcome).toBe(result.outcome)
        // A repeated recovery of a terminal record must not rewind later history.
        const state = await readState(home)
        state.lastSnapshots.web = 'snap-later'
        await writeState(home, state)
        await reconcilePromotion({ ...ctx, breakStaleLock: true }, record.id)
        expect((await readState(home)).lastSnapshots.web).toBe('snap-later')
        expect((await readFile(journalPath(home), 'utf8')).trim().split('\n')).toHaveLength(1)
        await mkdir(join(home, 'world-line', 'jobs'), { recursive: true })
        const jobId = `job-${labId.toLowerCase()}`
        await writeFile(
          join(home, 'world-line', 'jobs', `${jobId}.json`),
          JSON.stringify({
            id: jobId,
            kind: 'promote',
            labId,
            transactionId: record.id,
            status: 'running',
            phase: 'swapping',
            probes: [],
            startedAt: new Date().toISOString(),
            schemaVersion: 1,
            profileName: 'web',
            resource: 'origin',
            ownerPid: 2147483647,
            ownerHost: hostname(),
          }),
        )
        expect(getJob(jobId, { home, profileName: 'web' })?.status).toBe(committed ? 'ok' : 'error')
      } finally {
        await destroyTempHome(home)
      }
    })
  }
  test('rollback restores secret-skipped original bytes rather than deleting them', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId, officialDir } = await seedPassedLab(home, now, fakeBin, READY_PROBES)
      ctx.env.WORLD_LINE_DISABLE_KEYCHAIN = '1'
      delete ctx.env.WORLD_LINE_SECRET_KEY
      const original = '- id: example\n  config:\n    apiKey: fixture-private-secret\n'
      await writeFile(join(officialDir, 'cordis.patch.yml'), original)
      const manifest = JSON.parse(await readFile(labManifestPath(home, labId), 'utf8'))
      manifest.source.receipt = (
        await analyzeProfile({ home, profileName: 'web', adapter: adapterDsh01x })
      ).receipt.tree
      await writeFile(labManifestPath(home, labId), JSON.stringify(manifest))
      await expect(
        runLabPromote(ctx, {
          labId,
          onPhase: (phase) => {
            if (phase === 'swapped') throw new Error('injected failure')
          },
        }),
      ).rejects.toThrow('rolled back')
      expect(await readFile(join(officialDir, 'cordis.patch.yml'), 'utf8')).toBe(original)
      const record = (await listTransactions(home))[0]!
      expect(record.phase).toBe('rolled-back')
      expect(JSON.stringify(record)).not.toContain('fixture-private-secret')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('commit metadata failure retains the decision and later reconciliation completes it', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const { ctx, labId, officialDir } = await seedPassedLab(
        home,
        () => new Date('2026-09-04T12:00:00.000Z'),
        fakeBin,
        READY_PROBES,
      )
      ctx.env.WORLD_LINE_DISABLE_KEYCHAIN = '1'
      const candidate = (await readFile(join(officialDir, 'package.json'), 'utf8')) + '\n'
      await writeFile(join(labProfileDir(home, labId, 'web'), 'package.json'), candidate)
      await expect(
        runLabPromote(ctx, {
          labId,
          onPhase: (phase) => {
            if (phase === 'journal') throw new Error('journal unavailable')
          },
        }),
      ).rejects.toThrow('reconciliation')
      const record = (await listTransactions(home))[0]!
      expect(record.phase).toBe('committing')
      expect(await readFile(join(officialDir, 'package.json'), 'utf8')).toBe(candidate)
      await reconcilePromotion(ctx, record.id)
      expect((await readTransaction(home, record.id)).phase).toBe('committed')
    } finally {
      await destroyTempHome(home)
    }
  })
})

test('v2 checks bind candidate content before a reviewed merge', async () => {
  const home = await makeTempHome()
  try {
    const fakeBin = await installFakeDsh(home),
      now = () => new Date('2026-09-04T12:00:00.000Z')
    const probes = [
      probe(now(), 'browser-boot', 'core', 'pass'),
      probe(now(), 'plugin-function', 'coverage', 'skip', { required: false }),
      probe(now(), 'client-observations', 'review', 'inconclusive'),
    ]
    const { ctx, labId } = await seedPassedLab(home, now, fakeBin, probes)
    const manifest = JSON.parse(await readFile(labManifestPath(home, labId), 'utf8'))
    manifest.state = 'failed'
    await writeFile(labManifestPath(home, labId), JSON.stringify(manifest))
    const candidate = await analyzeProfile({
      home: labHomeDir(home, labId),
      profileName: 'web',
      adapter: adapterDsh01x,
    })
    const evidence = {
      policyVersion: 2,
      sourceReceipt: manifest.source.receipt,
      candidateReceipt: candidate.receipt.tree,
      hostVersion: '0.1.2-rc.1',
      probes,
    }
    await writeFile(
      labProbePath(home, labId),
      JSON.stringify({ ...evidence, candidateReceipt: 'changed' }),
    )
    await expect(runLabPromote(ctx, { labId, acceptReview: true })).rejects.toThrow(
      '验证记录不一致',
    )
    await writeFile(labProbePath(home, labId), JSON.stringify(evidence))
    const result = await runLabPromote(ctx, { labId, acceptReview: true })
    expect(result.ok).toBe(true)
    expect(result.lastKnownGood).toBeNull()
    const journal = JSON.parse((await readFile(journalPath(home), 'utf8')).trim())
    expect(journal.reviewAcceptance).toMatchObject({
      policyVersion: 2,
      labId,
      unresolvedChecks: ['client-observations'],
    })
  } finally {
    await destroyTempHome(home)
  }
})
