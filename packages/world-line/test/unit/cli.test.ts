/**
 * CLI end-to-end coverage over fixture DSH homes (acceptance 1, 4, 6, 8, 9
 * read-only slices): envelopes, exit codes, secret hygiene, lock semantics,
 * and the snapshot → timeline round trip.
 */

import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import { makeTempHome, profilePackageJson, runCliIn, writeProfile } from '../helpers/fixture.js'

/** Assert the fixed clock so snapshot ids are deterministic. */
function fixedNow(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
}

describe('CLI surface', () => {
  test('help exits 0; bare invocation exits 2; unknown command exits 2', async () => {
    const help = await runCliIn({ argv: ['--help'] })
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('dsh-world-line')
    const bare = await runCliIn({ argv: [] })
    expect(bare.exitCode).toBe(2)
    expect(bare.stderr).toContain('dsh-world-line')
    const unknown = await runCliIn({ argv: ['frobnicate'] })
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toContain('unknown command')
  })

  test('phase-gated commands explain their roadmap', async () => {
    const restore = await runCliIn({ argv: ['restore', 'snap-x'] })
    expect(restore.exitCode).toBe(2)
    expect(restore.stderr).toContain('Phase 4')
    const rescue = await runCliIn({ argv: ['rescue', 'start'] })
    expect(rescue.exitCode).toBe(2)
    expect(rescue.stderr).toContain('Phase 4')
  })

  test('--version and -V print the package version and exit 0', async () => {
    const long = await runCliIn({ argv: ['--version'] })
    expect(long.exitCode).toBe(0)
    expect(long.stdout.trim()).toBe('0.1.0')
    const short = await runCliIn({ argv: ['-V'] })
    expect(short.exitCode).toBe(0)
    expect(short.stdout.trim()).toBe('0.1.0')
    const help = await runCliIn({ argv: ['--help'] })
    expect(help.stdout).toContain('--version')
  })

  test('snapshot create refuses a live lock even with --break-stale-lock', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      await mkdtempPlaceholderLock(home, process.pid)
      const result = await runCliIn({
        argv: ['snapshot', 'create', '--break-stale-lock', '--json'],
        home,
      })
      expect(result.exitCode).toBe(2)
      expect(result.stdout).not.toContain('snap-')
      const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } }
      expect(envelope.ok).toBe(false)
      expect(envelope.error.code).toBe('E_LOCKED')
      const human = await runCliIn({ argv: ['snapshot', 'create'], home })
      expect(human.exitCode).toBe(2)
      expect(human.stderr).toContain('writer lock held')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('snapshot create refuses a stale lock without confirmation and honours it with the flag', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      await mkdtempPlaceholderLock(home, 2147483647)
      const refused = await runCliIn({ argv: ['snapshot', 'create'], home, now: fixedNow() })
      expect(refused.exitCode).toBe(2)
      expect(refused.stderr).toContain('--break-stale-lock')
      const accepted = await runCliIn({
        argv: ['snapshot', 'create', '--break-stale-lock'],
        home,
        now: fixedNow(),
      })
      expect(accepted.exitCode).toBe(0)
      expect(accepted.stdout).toMatch(/snap-20260101T\d{6}Z-[0-9a-f]{8}/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('snapshot → timeline round trip', () => {
  test('two snapshots, parent chaining, diff, and secret hygiene', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      // One clock shared by all runs in this test so snapshot ids advance.
      const clock = fixedNow()
      const secret = 'sk-supersecret1234567890'
      const before = await runCliIn({
        argv: ['snapshot', 'create', '--label', 'before'],
        home,
        now: clock,
      })
      expect(before.exitCode, `stderr: ${before.stderr} stdout: ${before.stdout}`).toBe(0)
      expect(before.stdout).toMatch(/snap-20260101T\d{6}Z-[0-9a-f]{8}/)
      expect(before.stdout).not.toContain(secret)

      // Add a secret-bearing entry + a dependency change, then snapshot again.
      const profileDir = join(home, 'profiles', 'web')
      await writeFile(
        join(profileDir, 'cordis.patch.yml'),
        `- id: gate\n  config:\n    apiKey: ${secret}\n`,
      )
      await writeFile(
        join(profileDir, 'package.json'),
        profilePackageJson({
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          dependencies: { '@seaveyon/dsh-pet': '^0.2.0' },
        }),
      )
      const after = await runCliIn({
        argv: ['snapshot', 'create', '--label', 'after'],
        home,
        now: clock,
      })
      expect(after.exitCode).toBe(0)

      // Neither human nor JSON output leaks the secret.
      expect(after.stdout).not.toContain(secret)
      const jsonRun = await runCliIn({
        argv: ['snapshot', 'create', '--label', 'after-json', '--json'],
        home,
        now: clock,
      })
      expect(jsonRun.exitCode).toBe(0)
      expect(jsonRun.stdout).not.toContain(secret)
      const envelope = JSON.parse(jsonRun.stdout) as {
        ok: boolean
        schemaVersion: number
        data: { id: string; parentId: string | null; skippedSecrets: string[] }
      }
      expect(envelope.ok).toBe(true)
      expect(envelope.schemaVersion).toBe(1)
      expect(envelope.data.skippedSecrets).toContain('cordis.patch.yml')
      const thirdId = envelope.data.id

      // Vault layout matches the spec's storage model.
      const vault = join(home, 'world-line')
      expect(await readdir(join(vault, 'vault', 'snapshots'))).toHaveLength(3)
      const objects = await readdir(join(vault, 'vault', 'objects'))
      expect(objects.length).toBeGreaterThan(0)

      // The secret-bearing file never landed in the object store.
      const secretInObject = (
        await Promise.all(
          objects.map(async (name) =>
            (await readFile(join(vault, 'vault', 'objects', name), 'utf8')).includes(secret),
          ),
        )
      ).some(Boolean)
      expect(secretInObject).toBe(false)

      // timeline list / show / diff.
      const list = await runCliIn({ argv: ['timeline', 'list'], home })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain('before')
      expect(list.stdout).toContain('after')

      const show = await runCliIn({ argv: ['timeline', 'show', thirdId, '--json'], home })
      expect(show.exitCode).toBe(0)
      const shown = JSON.parse(show.stdout) as {
        ok: boolean
        data: { manifest: { files: Array<{ name: string; secretSkipped: boolean }> } }
      }
      expect(
        shown.data.manifest.files.find((file) => file.name === 'cordis.patch.yml')?.secretSkipped,
      ).toBe(true)
      expect(show.stdout).not.toContain(secret)

      const firstId = await firstSnapshotId(home)
      const diff = await runCliIn({ argv: ['timeline', 'diff', firstId, thirdId, '--json'], home })
      expect(diff.exitCode).toBe(0)
      const diffed = JSON.parse(diff.stdout) as {
        ok: boolean
        data: {
          diff: {
            files: Array<{ name: string; status: string }>
            patches: unknown[]
            dependencies: Array<{ name: string; status: string }>
          }
        }
      }
      const changedFiles = diffed.data.diff.files.filter((file) => file.status !== 'unchanged')
      expect(changedFiles.length).toBeGreaterThanOrEqual(2)
      expect(changedFiles.some((file) => file.name === 'cordis.patch.yml')).toBe(true)
      expect(
        diffed.data.diff.dependencies.some(
          (dep) => dep.name === '@seaveyon/dsh-pet' && dep.status === 'added',
        ),
      ).toBe(true)
      expect(diff.stdout).not.toContain(secret)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('timeline show with no snapshots fails cleanly; corrupt manifest is an internal error', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      const none = await runCliIn({ argv: ['timeline', 'show'], home })
      expect(none.exitCode).toBe(2)
      expect(none.stderr).toContain('no snapshot')
      await mkdirRecursive(join(home, 'world-line', 'vault', 'snapshots'))
      await writeFile(
        join(home, 'world-line', 'vault', 'snapshots', 'snap-20260101T000000Z-deadbeef.json'),
        '{broken',
      )
      const corrupt = await runCliIn({ argv: ['timeline', 'list', '--json'], home })
      expect(corrupt.exitCode).toBe(0)
      const parsed = JSON.parse(corrupt.stdout) as { data: { corrupt: string[] } }
      expect(parsed.data.corrupt).toHaveLength(1)
      const showCorrupt = await runCliIn({
        argv: ['timeline', 'show', 'snap-20260101T000000Z-deadbeef', '--json'],
        home,
      })
      expect(showCorrupt.exitCode).toBe(3)
      const errEnvelope = JSON.parse(showCorrupt.stdout) as {
        ok: boolean
        error: { code: string; exitCode: number }
      }
      expect(errEnvelope.ok).toBe(false)
      expect(errEnvelope.error.code).toBe('E_INTERNAL')
      expect(errEnvelope.error.exitCode).toBe(3)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('doctor', () => {
  test('healthy fixture exits 0; broken patch layer exits 1', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      const healthy = await runCliIn({ argv: ['doctor'], home })
      expect(healthy.exitCode).toBe(0)
      expect(healthy.stdout).toContain('verdict: PASS')

      await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- id: [unclosed\n')
      const broken = await runCliIn({ argv: ['doctor'], home })
      expect(broken.exitCode).toBe(1)
      expect(broken.stdout).toContain('verdict: FAIL')

      const json = await runCliIn({ argv: ['doctor', '--json'], home })
      expect(json.exitCode).toBe(1)
      const envelope = JSON.parse(json.stdout) as {
        ok: boolean
        data: { summary: { failed: number }; checks: Array<{ id: string; status: string }> }
      }
      expect(envelope.ok).toBe(true)
      expect(envelope.data.summary.failed).toBeGreaterThan(0)
      expect(envelope.data.checks.find((check) => check.id === 'profile-patch')?.status).toBe(
        'fail',
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('missing profile fails doctor with candidate names and snapshot with exit 2', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'pettest')
      const doctor = await runCliIn({ argv: ['doctor', '--profile', 'web'], home })
      expect(doctor.exitCode).toBe(1)
      expect(doctor.stdout).toContain('pettest')
      const snapshot = await runCliIn({ argv: ['snapshot', 'create', '--profile', 'web'], home })
      expect(snapshot.exitCode).toBe(2)
      expect(snapshot.stderr).toContain('pettest')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('doctor never prints secret values', async () => {
    const home = await makeTempHome()
    try {
      const secret = 'ghp_secretvalue123456789012'
      await writeProfile(home, 'web', {
        patchYaml: `- id: gate\n  config:\n    token: ${secret}\n`,
      })
      const result = await runCliIn({ argv: ['doctor'], home })
      expect(result.stdout).not.toContain(secret)
      expect(result.stderr).not.toContain(secret)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('empty DSH home', () => {
  test('snapshot create refuses before creating any store or lock state', async () => {
    const home = await makeTempHome()
    try {
      const result = await runCliIn({ argv: ['snapshot', 'create', '--json'], home })
      expect(result.exitCode).toBe(2)
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean
        error: { code: string; message: string }
      }
      expect(envelope.ok).toBe(false)
      expect(envelope.error.code).toBe('E_FILE')
      expect(envelope.error.message).toContain('no profiles yet')
      // Preflight ordering: a missing profile must not create the home's
      // world-line store, lock files, or anything else.
      expect(await readdir(home)).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('doctor diagnoses it without a crash and exits 1', async () => {
    const home = await makeTempHome()
    try {
      const result = await runCliIn({ argv: ['doctor', '--json'], home })
      expect(result.exitCode).toBe(1)
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean
        data: { checks: { id: string; status: string }[] }
      }
      expect(envelope.ok).toBe(true)
      const profileCheck = envelope.data.checks.find((check) => check.id === 'profile-exists')
      expect(profileCheck?.status).toBe('fail')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

/** Write a lock file whose holder is `pid`. */
async function mkdtempPlaceholderLock(home: string, pid: number): Promise<void> {
  const { hostname } = await import('node:os')
  const dir = join(home, 'world-line', 'locks')
  await mkdirRecursive(dir)
  await writeFile(
    join(dir, 'web.lock'),
    JSON.stringify({
      pid,
      host: hostname(),
      startedAt: '2020-01-01T00:00:00Z',
      purpose: 'fixture lock',
      token: 'fixture-token',
    }),
  )
}

async function mkdirRecursive(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}

/** First snapshot id for the web profile in a home. */
async function firstSnapshotId(home: string): Promise<string> {
  const names = await readdir(join(home, 'world-line', 'vault', 'snapshots'))
  return names.sort()[0]?.replace(/\.json$/, '') ?? ''
}
