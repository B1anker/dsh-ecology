import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { newRescueId, rescueDir, rescueHomeDir } from '../../src/commands/rescue.js'
import type { CliContext } from '../../src/context.js'
import { UsageError } from '../../src/domain/errors.js'
import type { ProbeResult } from '../../src/domain/probe.js'
import { type LabManifest, writeLabManifest } from '../../src/lab/manifest.js'
import { noteLastKnownGood } from '../../src/vault/state.js'
import { apply, type OperateDeps, operate, worldLines } from '../../src/web/index.js'
import type { Job } from '../../src/web/jobs.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

describe('world-line Web boundary', () => {
  test('native authentication precedes reads and mutations; writes require same-origin JSON', async () => {
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    let disposed = false
    const cleanups: Array<() => void> = []
    apply({
      get: <T>(name: string) =>
        (name === 'webServer'
          ? {
              register: (route: { handler: typeof handler }) => {
                handler = route.handler
                return () => {
                  disposed = true
                }
              },
            }
          : {
              requestRejection: (req: IncomingMessage) =>
                req.headers.cookie === 'fixture=valid' ? undefined : 401,
            }) as T,
      effect: (setup) => {
        cleanups.push(setup())
      },
    })
    const server = createServer((req, res) => void handler!(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}`
    try {
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { method: 'POST', body: '{"action":"create"}' })).status).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: {
              cookie: 'fixture=valid',
              origin: 'https://evil.example',
              'content-type': 'application/json',
            },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { cookie: 'fixture=valid', 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { cookie: 'fixture=valid', origin: url, 'content-type': 'text/plain' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cleanups.forEach((fn) => fn())
    }
    expect(disposed).toBe(true)
  })
  test('lists lineage without secrets, rejects cross-profile and self-stop, preserves identity on rename/default', async () => {
    const home = await makeTempHome()
    const ctx: CliContext = {
      home,
      cwd: home,
      env: {},
      profileName: 'web',
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const id = 'lab-20260906T120000Z-11111111'
    const other = 'lab-20260906T120000Z-22222222'
    const manifest: LabManifest = {
      manifestVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adapterId: 'test',
      dshVersion: 'test',
      runtime: { nodeVersion: 'test', os: 'test', arch: 'test' },
      source: { profileName: 'web', receipt: 'secret-receipt', parentLabId: other },
      purpose: 'mirror',
      state: 'passed',
      runCount: 0,
      plan: [],
      retention: { cleanupMode: 'keep-on-failure' },
    }
    try {
      await writeLabManifest(home, manifest, new Date())
      await writeLabManifest(
        home,
        { ...manifest, id: other, source: { profileName: 'headless', receipt: 'secret' } },
        new Date(),
      )
      const listed = await worldLines(ctx, id)
      expect(listed.lines.length).toBe(1)
      expect(listed.lines[0]?.parentId).toBe(other)
      expect(JSON.stringify(listed)).not.toContain('secret')
      expect(listed.lines[0]?.verdict).toBe(null)
      await expect(operate(ctx, { action: 'stop', id }, id)).rejects.toThrow('另一实例')
      await expect(operate(ctx, { action: 'destroy', id }, id)).rejects.toThrow('另一实例')
      await expect(operate(ctx, { action: 'start', id: other })).rejects.toThrow('profile')
      await expect(
        operate(ctx, { action: 'create', from: other, alias: 'cross-profile' }),
      ).rejects.toThrow('profile')
      await operate(ctx, { action: 'alias', id, alias: 'my-world' })
      await operate(ctx, { action: 'default', id: 'my-world' })
      expect((await worldLines(ctx)).lines[0]).toMatchObject({
        id,
        alias: 'my-world',
        isDefault: true,
      })
    } finally {
      await destroyTempHome(home)
    }
  })
  test('GET payload carries lastKnownGood: null on a fresh home, non-null once recorded', async () => {
    const home = await makeTempHome()
    const ctx: CliContext = {
      home,
      cwd: home,
      env: {},
      profileName: 'web',
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    try {
      expect((await worldLines(ctx)).lastKnownGood).toBe(null)
      await noteLastKnownGood(home, 'web', 'snap-stable-1')
      expect((await worldLines(ctx)).lastKnownGood).toBe('snap-stable-1')
    } finally {
      await destroyTempHome(home)
    }
  })
})

function makeCtx(home: string, env: NodeJS.ProcessEnv = {}): CliContext {
  return {
    home,
    cwd: home,
    env: { ...process.env, DSH_HOME: home, ...env },
    profileName: 'web',
    json: true,
    breakStaleLock: false,
    now: () => new Date(),
  }
}

function labManifest(id: string, profileName = 'web'): LabManifest {
  const now = new Date().toISOString()
  return {
    manifestVersion: 1,
    id,
    createdAt: now,
    updatedAt: now,
    adapterId: 'test',
    dshVersion: 'test',
    runtime: { nodeVersion: 'test', os: 'test', arch: 'test' },
    source: { profileName, receipt: '00'.repeat(32) },
    state: 'passed',
    runCount: 1,
    plan: [],
    retention: { cleanupMode: 'keep-on-failure' },
  }
}

function probeResult(check: string): ProbeResult {
  return {
    check,
    label: `${check} label`,
    required: true,
    startedAt: '2026-09-04T10:00:00.000Z',
    finishedAt: '2026-09-04T10:00:01.000Z',
    status: 'pass',
  }
}

async function pollJob(ctx: CliContext, jobId: string): Promise<Job> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = (await operate(ctx, { action: 'job', id: jobId })) as Job
    if (job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`job ${jobId} never reached a terminal state`)
}

describe('world-line Web lab/job actions', () => {
  test('new actions reject invalid input with usage errors', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    try {
      await expect(operate(ctx, { action: 'lab-add' })).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'lab-add', spec: 42 })).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'lab-add', spec: '  ' })).rejects.toBeInstanceOf(
        UsageError,
      )
      await expect(
        operate(ctx, { action: 'lab-add', spec: '@x/y', keep: 'yes' }),
      ).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'restore' })).rejects.toBeInstanceOf(UsageError)
      await expect(
        operate(ctx, { action: 'restore', snapshotId: 'snap-x', lastKnownGood: true }),
      ).rejects.toBeInstanceOf(UsageError)
      await expect(
        operate(ctx, { action: 'restore', lastKnownGood: 'yes' }),
      ).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'job' })).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'job', id: 'job-gone' })).rejects.toThrow('已结束')
      await expect(operate(ctx, { action: 'report' })).rejects.toBeInstanceOf(UsageError)
      await expect(operate(ctx, { action: 'rescue-stop' })).rejects.toBeInstanceOf(UsageError)
      await expect(
        operate(ctx, { action: 'rescue-start', allow: 'ui-workspace' }),
      ).rejects.toBeInstanceOf(UsageError)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('promote refuses a lab owned by another profile', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    const other = 'lab-20260906T120000Z-22222222'
    try {
      await writeLabManifest(home, labManifest(other, 'headless'), new Date())
      await expect(operate(ctx, { action: 'promote', id: other })).rejects.toThrow('profile')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('lab-add returns a job id; the job accumulates probes and lands ok', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    try {
      const sourceId = 'lab-20260906T120000Z-11223344'
      await writeLabManifest(home, { ...labManifest(sourceId), purpose: 'mirror' }, new Date())
      const labAdd: NonNullable<OperateDeps['labAdd']> = async (_ctx, _spec, options) => {
        expect(options.clientProbes).toBe(true)
        expect(options.keep).toBe(true)
        expect(options.sourceId).toBe(sourceId)
        options.onProbe?.(probeResult('plugin-add'))
        options.onProbe?.(probeResult('compose'))
        return {
          profileName: 'web',
          labId: null,
          action: 'add',
          spec: '@fixture/candidate@1.0.0',
          ok: true,
          deleted: true,
          kept: false,
          probeSummary: {
            total: 2,
            passed: 2,
            failed: 0,
            warned: 0,
            skipped: 0,
            inconclusive: 0,
            ok: true,
          },
          port: 51999,
          expiresAt: undefined,
          dshVersion: '0.1.2-rc.1',
        }
      }
      const started = (await operate(
        ctx,
        { action: 'lab-add', spec: '@fixture/candidate', sourceId },
        undefined,
        {
          labAdd,
        },
      )) as { jobId: string }
      expect(started.jobId).toMatch(/^job-/)
      const job = await pollJob(ctx, started.jobId)
      expect(job.status).toBe('ok')
      expect(job.kind).toBe('lab-add')
      expect(job.probes.map((entry) => entry.check)).toEqual(['plugin-add', 'compose'])
      expect(job.result).toMatchObject({ ok: true, action: 'add' })
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a throwing runner lands the job in error with a redacted message', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    try {
      const labAdd: NonNullable<OperateDeps['labAdd']> = () =>
        Promise.reject(new Error('pnpm failed with token=deadbeefcafe'))
      const started = (await operate(ctx, { action: 'lab-add', spec: '@fixture/bad' }, undefined, {
        labAdd,
      })) as { jobId: string }
      const job = await pollJob(ctx, started.jobId)
      expect(job.status).toBe('error')
      expect(job.error).toContain('<redacted>')
      expect(job.error).not.toContain('deadbeefcafe')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('promote and restore run as jobs with phase/probe progress', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    const labId = 'lab-20260906T120000Z-33333333'
    try {
      await writeLabManifest(home, labManifest(labId), new Date())
      const promote: NonNullable<OperateDeps['promote']> = async (_ctx, id, options) => {
        options.onPhase?.('gate')
        options.onPhase?.('swap')
        return {
          profileName: 'web',
          labId: id,
          clientGate: 'pass',
          preSnapshot: 'snap-pre',
          afterSnapshot: 'snap-after',
          appliedFiles: ['package.json'],
          restartVerified: false,
          lastKnownGood: null,
          journalId: 'journal-x',
        }
      }
      const started = (await operate(ctx, { action: 'promote', id: labId }, undefined, {
        promote,
      })) as { jobId: string }
      const promotedJob = await pollJob(ctx, started.jobId)
      expect(promotedJob.status).toBe('ok')
      expect(promotedJob.phase).toBe('swap')
      expect(promotedJob.result).toMatchObject({ labId, journalId: 'journal-x' })

      const restore: NonNullable<OperateDeps['restore']> = async (_ctx, options) => {
        options.onProbe?.(probeResult('host-boot'))
        options.onPhase?.('after-snapshot')
        return {
          ok: true,
          kind: 'verify',
          snapshotId: 'snap-x',
          labId: 'lab-y',
          clientGate: 'skipped',
        }
      }
      const restoreStarted = (await operate(
        ctx,
        { action: 'restore', lastKnownGood: true },
        undefined,
        { restore },
      )) as { jobId: string }
      const restoreJob = await pollJob(ctx, restoreStarted.jobId)
      expect(restoreJob.status).toBe('ok')
      expect(restoreJob.phase).toBe('after-snapshot')
      expect(restoreJob.probes.map((entry) => entry.check)).toEqual(['host-boot'])
      expect(restoreJob.result).toMatchObject({ ok: true, kind: 'verify' })
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('world-line Web maintenance actions', () => {
  test('doctor returns the check table for the fixture home', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      await writeProfile(home, 'web')
      const ctx = makeCtx(home, { PATH: `${fakeBin}:${process.env.PATH ?? ''}` })
      const result = (await operate(ctx, { action: 'doctor' })) as {
        checks: { id: string; status: string }[]
        profileName: string
      }
      expect(result.profileName).toBe('web')
      expect(result.checks.length).toBeGreaterThan(0)
      expect(result.checks.find((check) => check.id === 'dsh-binary')?.status).toBe('ok')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('report writes a redacted bundle and returns its path', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    const labId = 'lab-20260906T120000Z-44444444'
    try {
      await writeLabManifest(home, labManifest(labId), new Date())
      const result = (await operate(ctx, { action: 'report', id: labId })) as { path: string }
      const bundle = JSON.parse(await readFile(result.path, 'utf8')) as {
        formatVersion: number
        report: { target: { kind: string; id: string } }
        redacted: boolean
      }
      expect(bundle.formatVersion).toBe(1)
      expect(bundle.report.target).toMatchObject({ kind: 'lab', id: labId })
      expect(bundle.redacted).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('rescue-plugins exposes patch ids and disabled states without configuration', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    try {
      expect(await operate(ctx, { action: 'rescue-plugins' })).toEqual({ plugins: [] })
      const dir = join(home, 'profiles', ctx.profileName)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'cordis.patch.yml'),
        '- id: web-login\n  config:\n    secret: do-not-expose\n- id: "pet"\n  disabled: true\n',
      )
      expect(await operate(ctx, { action: 'rescue-plugins' })).toEqual({
        plugins: [
          { id: 'web-login', disabled: false },
          { id: 'pet', disabled: true },
        ],
      })
    } finally {
      await destroyTempHome(home)
    }
  })

  test('rescue-list is empty on a fresh home; rescue-stop removes a seeded record', async () => {
    const home = await makeTempHome()
    const ctx = makeCtx(home)
    try {
      const empty = (await operate(ctx, { action: 'rescue-list' })) as { rescues: unknown[] }
      expect(empty.rescues).toEqual([])
      const id = newRescueId(new Date('2026-09-04T12:00:00.000Z'))
      await mkdir(rescueHomeDir(home, id), { recursive: true })
      const now = '2026-09-04T12:00:00.000Z'
      await writeFile(
        join(rescueDir(home, id), 'rescue.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            kind: 'rescue',
            id,
            createdAt: now,
            updatedAt: now,
            profileName: 'web',
            state: 'stopped',
            pid: null,
            port: null,
            hostVersion: '0.1.2-rc.1',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const listed = (await operate(ctx, { action: 'rescue-list' })) as {
        rescues: { id: string; alive: boolean }[]
      }
      expect(listed.rescues.map((rescue) => rescue.id)).toEqual([id])
      const stopped = (await operate(ctx, { action: 'rescue-stop', id })) as { removed: boolean }
      expect(stopped.removed).toBe(true)
      const after = (await operate(ctx, { action: 'rescue-list' })) as { rescues: unknown[] }
      expect(after.rescues).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })

  test('legacy rescue-start points to clean world lines without creating an instance', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      await writeProfile(home, 'web')
      const ctx = makeCtx(home, {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        WORLD_LINE_DISABLE_KEYCHAIN: '1',
      })
      await expect(operate(ctx, { action: 'rescue-start' })).rejects.toThrow('从干净环境开始')
      const listed = (await operate(ctx, { action: 'rescue-list' })) as { rescues: unknown[] }
      expect(listed.rescues).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })
})

test('retained verification routes are profile-scoped, reject mirrors and expose a retry job', async () => {
  const home = await makeTempHome()
  const ctx = makeCtx(home)
  const id = 'lab-20260907T120000Z-abcde123'
  try {
    await writeLabManifest(home, labManifest(id), new Date())
    const started = (await operate(
      ctx,
      { action: 'lab-verify', id, interactive: true },
      undefined,
      {
        labVerify: async (_ctx, target, options = {}) => {
          expect(target).toBe(id)
          expect(options.interactive).toBe(true)
          options.onProbe?.(probeResult('browser-boot'))
          return {
            labId: id,
            ok: true,
            kept: true,
            deleted: false,
            probeSummary: {
              total: 1,
              passed: 1,
              failed: 0,
              skipped: 0,
              warned: 0,
              inconclusive: 0,
              ok: true,
            },
          }
        },
      },
    )) as { jobId: string }
    expect((await pollJob(ctx, started.jobId)).kind).toBe('lab-verify')
    await expect(operate(ctx, { action: 'lab-verify', id, interactive: 'yes' })).rejects.toThrow(
      '无效',
    )
    await writeLabManifest(home, { ...labManifest(id), purpose: 'mirror' }, new Date())
    await expect(operate(ctx, { action: 'lab-verify', id })).rejects.toThrow('验证实验')
    await writeLabManifest(home, labManifest(id, 'other'), new Date())
    await expect(operate(ctx, { action: 'lab-verify', id })).rejects.toThrow('profile')
  } finally {
    await destroyTempHome(home)
  }
})

test('legacy host-only success stays incomplete and exposes a named retained lab', async () => {
  const home = await makeTempHome()
  const ctx = makeCtx(home)
  const id = 'lab-20260907T123037Z-c7457b48'
  try {
    await writeProfile(home, 'web')
    await writeLabManifest(
      home,
      {
        ...labManifest(id),
        plan: [{ seq: 1, action: 'add', id: '@seaveyon/dsh-pet', spec: '@seaveyon/dsh-pet' }],
        lastRun: {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          ok: true,
          exitCode: 0,
        },
      },
      new Date(),
    )
    const status = (await operate(ctx, { action: 'lab-status', id })) as {
      canPromote: boolean
      name: string
      clientGate: string
    }
    expect(status.canPromote).toBe(false)
    expect(status.clientGate).toBe('inconclusive')
    expect(status.name).toContain('@seaveyon/dsh-pet')
    const line = (await worldLines(ctx)).lines.find((item) => item.id === id)
    expect(line?.state).toBe('incomplete')
    expect(line?.verdict).toBe('incomplete')
    expect(line?.completedAt).toBeUndefined()
    const committedAt = new Date(Date.now() + 1000).toISOString()
    const entry = { profileName: 'web', labId: id, outcome: 'committed', createdAt: committedAt }
    await writeFile(
      join(home, 'world-line', 'journal.jsonl'),
      `${JSON.stringify({ ...entry, outcome: 'rolled-back' })}\ninvalid-row\n`,
    )
    expect(
      (await worldLines(ctx)).lines.find((item) => item.id === id)?.completedAt,
    ).toBeUndefined()
    await writeFile(join(home, 'world-line', 'journal.jsonl'), `${JSON.stringify(entry)}\n`)
    expect((await worldLines(ctx)).lines.find((item) => item.id === id)?.completedAt).toBe(
      committedAt,
    )
    await writeFile(
      join(home, 'world-line', 'journal.jsonl'),
      `${JSON.stringify({ ...entry, createdAt: '2000-01-01T00:00:00.000Z' })}\n`,
    )
    expect(
      (await worldLines(ctx)).lines.find((item) => item.id === id)?.completedAt,
    ).toBeUndefined()
  } finally {
    await destroyTempHome(home)
  }
})

test('verification source never falls back to main for invalid or non-mirror sources', async () => {
  const home = await makeTempHome()
  const ctx = makeCtx(home)
  const id = 'lab-20260906T120000Z-11223345'
  try {
    await expect(
      operate(ctx, { action: 'lab-add', spec: '@fixture/candidate', sourceId: id }),
    ).rejects.toThrow()
    await writeLabManifest(home, labManifest(id), new Date())
    await expect(
      operate(ctx, { action: 'lab-add', spec: '@fixture/candidate', sourceId: id }),
    ).rejects.toThrow('普通世界线')
    await writeLabManifest(home, { ...labManifest(id, 'headless'), purpose: 'mirror' }, new Date())
    await expect(
      operate(ctx, { action: 'lab-add', spec: '@fixture/candidate', sourceId: id }),
    ).rejects.toThrow('普通世界线')
  } finally {
    await destroyTempHome(home)
  }
})

describe('Phase 5 Web workflows', () => {
  for (const action of ['lab-update', 'lab-remove'] as const)
    test(`${action} keeps the selected source and browser gate`, async () => {
      const home = await makeTempHome(),
        ctx = makeCtx(home),
        sourceId = 'lab-20260907T120000Z-87654321'
      try {
        await writeLabManifest(home, { ...labManifest(sourceId), purpose: 'mirror' }, new Date())
        let received: any
        const runner: any = async (_ctx: CliContext, spec: string, options: any) => {
          received = { spec, options }
          return { ok: true }
        }
        const { jobId } = (await operate(
          ctx,
          {
            action,
            spec: action === 'lab-update' ? '@fixture/plugin@2' : '@fixture/plugin',
            sourceId,
          },
          undefined,
          action === 'lab-update' ? { labUpdate: runner } : { labRemove: runner },
        )) as { jobId: string }
        expect((await pollJob(ctx, jobId)).status).toBe('ok')
        expect(received.options).toMatchObject({
          sourceId,
          clientProbes: true,
          captureBaseline: true,
          keep: true,
        })
      } finally {
        await destroyTempHome(home)
      }
    })
  test('core removal is rejected before accepting a task', async () => {
    const home = await makeTempHome()
    try {
      await expect(
        operate(makeCtx(home), { action: 'lab-remove', spec: '@deepseek-ai/dsh-base' }),
      ).rejects.toThrow('核心运行层')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('composition and immutable snapshot comparison use the selected profile', async () => {
    const home = await makeTempHome(),
      ctx = makeCtx(home)
    try {
      await writeProfile(home, 'web')
      const composition = (await operate(ctx, { action: 'composition', id: 'origin' })) as any
      expect(composition.dependencies).toBeInstanceOf(Array)
      const a = (await operate(ctx, { action: 'snapshot', id: 'origin', label: '之前' })) as {
        snapshotId: string
      }
      const b = (await operate(ctx, { action: 'snapshot', id: 'origin', label: '之后' })) as {
        snapshotId: string
      }
      const result = (await operate(ctx, {
        action: 'snapshot-compare',
        from: { lineId: 'origin', kind: 'snapshot', snapshotId: a.snapshotId },
        to: { lineId: 'origin', kind: 'snapshot', snapshotId: b.snapshotId },
      })) as any
      expect(result.from.id).toBe(a.snapshotId)
      expect(result.to.id).toBe(b.snapshotId)
      expect(result.diff.files.every((f: any) => f.status === 'unchanged')).toBe(true)
      await expect(
        operate(ctx, {
          action: 'snapshot-compare',
          from: { lineId: 'origin', kind: 'snapshot', snapshotId: a.snapshotId, home: '/tmp' },
          to: { lineId: 'origin', kind: 'current' },
        }),
      ).rejects.toThrow('无效比较引用')
    } finally {
      await destroyTempHome(home)
    }
  })
})
