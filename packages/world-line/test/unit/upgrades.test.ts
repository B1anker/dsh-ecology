/**
 * The upgrade subsystem's pure and file-level parts: version ordering, the
 * per-source policy file, the results listing, and the scheduler tick's
 * gating — everything short of the registry lookups and the lab run that
 * `checkUpgrades` drives, which need a real pnpm and a bootable DSH.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import { UsageError } from '../../src/domain/errors.js'
import { sha256Hex } from '../../src/fs/hash.js'
import { getJob } from '../../src/web/jobs.js'
import {
  isNewerVersion,
  upgradePolicy,
  upgradeResults,
  upgradeTick,
} from '../../src/workflows/upgrades.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => destroyTempHome(home)))
})

async function context(profileName = 'web'): Promise<CliContext> {
  const home = await makeTempHome()
  homes.push(home)
  return {
    home,
    profileName,
    cwd: home,
    env: {},
    json: true,
    breakStaleLock: false,
    now: () => new Date('2026-09-17T02:00:00.000Z'),
  }
}

const policiesDir = (ctx: CliContext) => join(ctx.home, 'world-line', 'upgrade-policies')
const policyFile = (ctx: CliContext, sourceId: string) =>
  join(policiesDir(ctx), `${sha256Hex(`${ctx.profileName}\0${sourceId}`)}.json`)
const resultsDir = (ctx: CliContext) => join(ctx.home, 'world-line', 'upgrade-results')

describe('isNewerVersion', () => {
  test('orders releases numerically, not lexically', () => {
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerVersion('0.1.2', '0.1.2')).toBe(false)
    expect(isNewerVersion('0.1.1', '0.1.2')).toBe(false)
  })

  test('a release is newer than its own prerelease, and prereleases order by identifier', () => {
    expect(isNewerVersion('0.1.2', '0.1.2-rc.1')).toBe(true)
    expect(isNewerVersion('0.1.2-rc.1', '0.1.2')).toBe(false)
    expect(isNewerVersion('0.1.2-rc.2', '0.1.2-rc.1')).toBe(true)
    expect(isNewerVersion('0.1.2-rc.10', '0.1.2-rc.9')).toBe(true)
    expect(isNewerVersion('0.1.2-beta', '0.1.2-alpha')).toBe(true)
    // Numeric identifiers rank below alphanumeric ones (SemVer §11).
    expect(isNewerVersion('0.1.2-alpha', '0.1.2-1')).toBe(true)
    expect(isNewerVersion('0.1.2-1', '0.1.2-alpha')).toBe(false)
    // A longer identifier list wins when the shared prefix ties.
    expect(isNewerVersion('0.1.2-rc.1.1', '0.1.2-rc.1')).toBe(true)
    expect(isNewerVersion('0.1.2-rc.1', '0.1.2-rc.1.1')).toBe(false)
    expect(isNewerVersion('0.1.2-rc.1', '0.1.2-rc.1')).toBe(false)
  })

  test('build metadata is ignored and anything malformed never authorizes a change', () => {
    expect(isNewerVersion('0.1.3+build.7', '0.1.2')).toBe(true)
    expect(isNewerVersion('0.1.2+b', '0.1.2+a')).toBe(false)
    for (const [candidate, current] of [
      ['0.1.3', undefined],
      ['0.1.3', ''],
      ['0.1.3', 'latest'],
      ['v0.1.3', '0.1.2'],
      ['0.1', '0.1.2'],
      ['01.1.3', '0.1.2'],
      ['0.1.3-', '0.1.2'],
      ['^0.1.3', '0.1.2'],
    ] as const) {
      expect(isNewerVersion(candidate, current), `${candidate} vs ${current}`).toBe(false)
    }
  })
})

describe('upgradePolicy', () => {
  test('reads a disabled default when no policy has been written', async () => {
    const ctx = await context()
    expect(await upgradePolicy(ctx, 'origin')).toEqual({
      version: 1,
      sourceId: 'origin',
      profile: 'web',
      enabled: false,
      hours: 24,
      nextAt: null,
    })
    await expect(readdir(policiesDir(ctx))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('writes an enabled policy with the next check one interval out, and reads it back', async () => {
    const ctx = await context()
    const before = Date.now()
    const written = (await upgradePolicy(ctx, 'origin', true, 6)) as { nextAt: string }
    expect(written).toMatchObject({
      version: 1,
      profile: 'web',
      sourceId: 'origin',
      enabled: true,
      hours: 6,
    })
    const nextAt = Date.parse(written.nextAt)
    expect(nextAt).toBeGreaterThanOrEqual(before + 6 * 3600_000)
    expect(nextAt).toBeLessThan(before + 6 * 3600_000 + 60_000)

    expect(JSON.parse(await readFile(policyFile(ctx, 'origin'), 'utf8'))).toEqual(written)
    expect(await upgradePolicy(ctx, 'origin')).toEqual(written)

    // Disabling keeps the file but flips the flag.
    const disabled = await upgradePolicy(ctx, 'origin', false)
    expect(disabled).toMatchObject({ enabled: false, hours: 24 })
    expect(await upgradePolicy(ctx, 'origin')).toEqual(disabled)
  })

  test('the interval is one to 168 whole hours', async () => {
    const ctx = await context()
    for (const hours of [0, 169, 1.5, Number.NaN, -1]) {
      await expect(upgradePolicy(ctx, 'origin', true, hours), String(hours)).rejects.toThrow(
        UsageError,
      )
    }
    await expect(readdir(policiesDir(ctx))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('policies are keyed per profile and per source', async () => {
    const web = await context()
    await upgradePolicy(web, 'origin', true, 12)
    const other: CliContext = { ...web, profileName: 'desk' }
    expect(await upgradePolicy(other, 'origin')).toMatchObject({ enabled: false, profile: 'desk' })
    expect(policyFile(web, 'origin')).not.toBe(policyFile(other, 'origin'))
    expect(policyFile(web, 'origin')).not.toBe(policyFile(web, 'lab-a'))
  })

  test('a source that is not a mirror of this profile is refused before any write', async () => {
    const ctx = await context()
    await expect(upgradePolicy(ctx, 'lab-does-not-exist', true, 2)).rejects.toThrow()
    await expect(readdir(policiesDir(ctx))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a corrupt policy file is an error, not a silent default', async () => {
    const ctx = await context()
    await mkdir(policiesDir(ctx), { recursive: true })
    await writeFile(policyFile(ctx, 'origin'), '{not json')
    await expect(upgradePolicy(ctx, 'origin')).rejects.toThrow(SyntaxError)
  })
})

describe('upgradeResults', () => {
  test('lists this profile’s job results and ignores other files', async () => {
    const ctx = await context()
    expect(await upgradeResults(ctx)).toEqual([])

    await mkdir(resultsDir(ctx), { recursive: true })
    const mine = { ok: true, profile: 'web', sourceId: 'origin', rows: [{ name: 'a' }] }
    const theirs = { ok: true, profile: 'desk', sourceId: 'origin', rows: [] }
    await writeFile(join(resultsDir(ctx), 'job-aaa-1.json'), JSON.stringify(mine))
    await writeFile(join(resultsDir(ctx), 'job-bbb-2.json'), JSON.stringify(theirs))
    await writeFile(join(resultsDir(ctx), 'notes.json'), JSON.stringify(mine))
    await writeFile(join(resultsDir(ctx), 'job-ccc-3.json.bak'), JSON.stringify(mine))
    expect(await upgradeResults(ctx)).toEqual([mine])
  })
})

describe('upgradeTick', () => {
  const duePolicy = (
    ctx: CliContext,
    sourceId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    version: 1,
    profile: ctx.profileName,
    sourceId,
    enabled: true,
    hours: 24,
    nextAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  })

  async function writePolicy(ctx: CliContext, sourceId: string, policy: unknown): Promise<string> {
    await mkdir(policiesDir(ctx), { recursive: true })
    const path = policyFile(ctx, sourceId)
    await writeFile(path, JSON.stringify(policy))
    return path
  }

  test('does nothing without a policies directory', async () => {
    const ctx = await context()
    await expect(upgradeTick(ctx)).resolves.toBeUndefined()
  })

  test('leaves every policy that is not due, not enabled, not this profile’s, or not sane untouched', async () => {
    const ctx = await context()
    const untouched = [
      duePolicy(ctx, 'a', { nextAt: new Date(Date.now() + 3600_000).toISOString() }),
      duePolicy(ctx, 'b', { enabled: false }),
      duePolicy(ctx, 'c', { profile: 'desk' }),
      duePolicy(ctx, 'd', { hours: 0 }),
      duePolicy(ctx, 'e', { hours: 500 }),
      duePolicy(ctx, 'f', { nextAt: 'someday' }),
      duePolicy(ctx, 'g', { version: 2 }),
    ]
    const paths = await Promise.all(
      untouched.map((policy) => writePolicy(ctx, policy.sourceId, policy)),
    )
    // A file whose name is not a policy digest is not even read.
    await writeFile(join(policiesDir(ctx), 'README.json'), '{not json')

    await upgradeTick(ctx)

    for (const [index, path] of paths.entries()) {
      expect(JSON.parse(await readFile(path, 'utf8')), untouched[index]?.sourceId).toEqual(
        untouched[index],
      )
    }
  })

  test('a due policy whose source is gone is skipped without being rescheduled', async () => {
    const ctx = await context()
    const policy = duePolicy(ctx, 'lab-vanished')
    const path = await writePolicy(ctx, 'lab-vanished', policy)
    await upgradeTick(ctx)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(policy)
  })

  test('a due policy is rescheduled one interval out and its check runs as a scoped job', async () => {
    const ctx = await context()
    const path = await writePolicy(ctx, 'origin', duePolicy(ctx, 'origin', { hours: 3 }))
    const before = Date.now()

    await upgradeTick(ctx)

    const after = JSON.parse(await readFile(path, 'utf8')) as { nextAt: string; lastJobId: string }
    expect(Date.parse(after.nextAt)).toBeGreaterThanOrEqual(before + 3 * 3600_000)
    expect(after.lastJobId).toMatch(/^job-/)

    // The job exists in this profile's scope. With no profile installed in
    // the fixture home the check itself fails, and that failure is recorded
    // on the job rather than thrown out of the tick.
    const deadline = Date.now() + 10_000
    let job = getJob(after.lastJobId, ctx)
    while (job?.finishedAt === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      job = getJob(after.lastJobId, ctx)
    }
    expect(job?.kind).toBe('upgrade-check')
    expect(job?.status).toBe('error')
    expect(job?.finishedAt).toBeDefined()

    // A second tick before the interval elapses starts nothing new.
    await upgradeTick(ctx)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(after)
  })
})
