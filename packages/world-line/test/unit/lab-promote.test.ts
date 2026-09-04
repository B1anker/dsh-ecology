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
import { labManifestPath, labProfileDir, newLabId } from '../../src/lab/layout.js'
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
    expect(classifyClientGate(bootOnly === undefined ? [] : [bootOnly])).toBe('pass')
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

  test('accepts inconclusive evidence with --accept-inconclusive', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      const now = () => new Date('2026-09-04T12:00:00.000Z')
      const { ctx, labId } = await seedPassedLab(home, now, fakeBin, [])
      const result = await runLabPromote(ctx, { labId, acceptInconclusive: true })
      expect(result.ok).toBe(true)
      expect(result.clientGate).toBe('inconclusive')
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
      const launchFake = async () => ({
        kind: 'ready' as const,
        handle: {
          pid: 1,
          url: 'http://127.0.0.1:9/',
          port: 9,
          stop: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
        },
        detail: '',
      })
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
        deps: { launch: launchFake, clientProbe: clientProbeFake },
      })
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
