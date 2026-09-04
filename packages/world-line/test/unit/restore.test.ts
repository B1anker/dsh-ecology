/**
 * Phase 4 restore tests: lab-first verification of a vault snapshot with a
 * fully faked boot/browser layer (no dsh spawns, no chromium, no network),
 * plus the `--promote` transaction (journal kind 'restore' + snapshotId,
 * atomic swap observable on the official profile), fail-closed behavior on
 * run failure, and legacy snapshot refusal when secret bytes were skipped.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { runRestoreCommand } from '../../src/commands/restore.js'
import type { CliContext } from '../../src/context.js'
import type { SnapshotManifest } from '../../src/domain/snapshot.js'
import { snapshotManifestPath } from '../../src/fs/paths.js'
import {
  CLIENT_BOOT_GLOBALS,
  CLIENT_SHELL_MARKERS,
  CLIENT_SHELL_STATES,
} from '../../src/host-adapters/dsh-client-0.1.x.js'
import type {
  BrowserContextLike,
  BrowserHandleLike,
  PageLike,
  ShellState,
} from '../../src/lab/browser.js'
import { journalPath } from '../../src/lab/journal.js'
import type { LaunchResult } from '../../src/lab/launcher.js'
import { labExists, labProfileDir } from '../../src/lab/layout.js'
import {
  destroyTempHome,
  installFakeDsh,
  makeTempHome,
  minimalLockfile,
  profilePackageJson,
  runCliIn,
  writeProfile,
} from '../helpers/fixture.js'

const PACKAGE_MARKER = '@deepseek-ai/dsh-web-app'

function makeCtx(home: string, fakeBin: string, now: () => Date): CliContext {
  return {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      WORLD_LINE_DISABLE_KEYCHAIN: '1',
    },
    home,
    profileName: 'web',
    json: false,
    breakStaleLock: false,
    now,
  }
}

function readyState(): ShellState {
  return {
    mountChildren: 1,
    buttons: ['新会话', '设置'],
    roles: ['tree'],
    bodyHas: ['暂无会话', '工作区', ...CLIENT_SHELL_MARKERS, CLIENT_SHELL_STATES[0] ?? ''],
    bootGlobals: [...CLIENT_BOOT_GLOBALS],
    bootEntries: 2,
  }
}

/** Deterministic browser triple that always reports a ready shell. */
const readyBrowser: BrowserHandleLike = {
  async newContext(): Promise<BrowserContextLike> {
    const page: PageLike = {
      async goto(): Promise<unknown> {
        return undefined
      },
      async waitForTimeout(): Promise<void> {},
      on(): void {},
      async evaluate<T>(): Promise<T> {
        return readyState() as T
      },
    }
    return {
      async newPage(): Promise<PageLike> {
        return page
      },
    }
  },
  async close(): Promise<void> {},
}

type DepsMaker = (
  stoppedRef: { count: number },
  failLaunch?: boolean,
) => {
  browserLaunch: () => Promise<BrowserHandleLike>
  launch: () => Promise<LaunchResult>
  httpGet: () => Promise<{ status: number }>
  capture: () => Promise<{
    exitCode: number
    signal: null
    timedOut: boolean
    spawnError: null
    stdout: string
    stderr: string
  }>
}
const makeDeps: DepsMaker = (stoppedRef, failLaunch = false) => ({
  browserLaunch: async () => readyBrowser,
  launch: async () =>
    failLaunch
      ? { kind: 'spawn-error', detail: 'boom' }
      : ({
          kind: 'ready',
          detail: 'ready',
          handle: {
            pid: 4242,
            url: 'http://127.0.0.1:51999/?token=abc',
            port: 51999,
            stop: async () => {
              stoppedRef.count += 1
              return { exitCode: 0, signal: null, stdout: '', stderr: '' }
            },
          },
        } satisfies LaunchResult),
  httpGet: async () => ({ status: 200 }),
  capture: async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    stdout: '[]\n',
    stderr: '',
  }),
})

interface Seeded {
  home: string
  ctx: CliContext
  fakeBin: string
  snapshotId: string
  brokenText: string
}

async function seedSnapshotHome(): Promise<Seeded> {
  const home = await makeTempHome()
  const fakeBin = await installFakeDsh(home)
  await writeProfile(home, 'web', {
    packageJson: profilePackageJson({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    }),
    lockfile: minimalLockfile('@deepseek-ai/dsh-base', '0.1.0'),
  })
  const captured = await runCliIn({
    argv: ['snapshot', 'create'],
    home,
    env: { WORLD_LINE_DISABLE_KEYCHAIN: '1', PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
  })
  expect(captured.exitCode).toBe(0)
  const snapshotId = captured.stdout.split('\n')[0]?.replace('snapshot  ', '') ?? ''
  expect(snapshotId).toMatch(/^snap-/)
  // Break the official profile afterwards: restore must rebuild from the
  // snapshot's bytes, never from the live (now broken) profile.
  const official = join(home, 'profiles', 'web', 'package.json')
  const text = await readFile(official, 'utf8')
  const brokenText = text.replace(
    `"${PACKAGE_MARKER}"`,
    `"@fixture/evil": "9.9.9",\n    "${PACKAGE_MARKER}"`,
  )
  await import('node:fs/promises').then(({ writeFile }) => writeFile(official, brokenText, 'utf8'))
  return {
    home,
    ctx: makeCtx(home, fakeBin, () => new Date('2026-09-04T12:00:00.000Z')),
    fakeBin,
    snapshotId,
    brokenText,
  }
}

describe('restore lab-first verification', () => {
  test('verify-only materializes snapshot bytes, keeps the lab, never touches the official profile', async () => {
    const seeded = await seedSnapshotHome()
    try {
      const stopped: { count: number } = { count: 0 }
      const result = await runRestoreCommand(seeded.ctx, {
        snapshotId: seeded.snapshotId,
        deps: makeDeps(stopped),
      })
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('verify')
      expect(result.labId).toMatch(/^lab-/)
      expect(stopped.count).toBe(1)
      expect(await labExists(seeded.home, result.labId)).toBe(true)
      const labPackage = await readFile(
        join(labProfileDir(seeded.home, result.labId, 'web'), 'package.json'),
        'utf8',
      )
      expect(labPackage).not.toContain('@fixture/evil')
      expect(labPackage).toContain(PACKAGE_MARKER)
      const official = await readFile(join(seeded.home, 'profiles', 'web', 'package.json'), 'utf8')
      expect(official).toBe(seeded.brokenText)
      const journal = await readFile(journalPath(seeded.home), 'utf8').catch(() => '')
      expect(journal).toBe('')
    } finally {
      await destroyTempHome(seeded.home)
    }
  })

  test('failed restore run keeps the lab in failed state and exits ok:false', async () => {
    const seeded = await seedSnapshotHome()
    try {
      const result = await runRestoreCommand(seeded.ctx, {
        snapshotId: seeded.snapshotId,
        deps: makeDeps({ count: 0 }, true),
      })
      expect(result.ok).toBe(false)
      const official = await readFile(join(seeded.home, 'profiles', 'web', 'package.json'), 'utf8')
      expect(official).toBe(seeded.brokenText)
      expect(await labExists(seeded.home, result.labId)).toBe(true)
    } finally {
      await destroyTempHome(seeded.home)
    }
  })

  test('--promote swaps snapshot bytes onto the official profile and journals kind restore', async () => {
    const seeded = await seedSnapshotHome()
    try {
      const result = await runRestoreCommand(seeded.ctx, {
        snapshotId: seeded.snapshotId,
        promote: true,
        deps: makeDeps({ count: 0 }),
      })
      expect(result.ok).toBe(true)
      expect(result.kind).toBe('promote')
      expect(result.preSnapshot).toMatch(/^snap-/)
      expect(result.afterSnapshot).toMatch(/^snap-/)
      const official = await readFile(join(seeded.home, 'profiles', 'web', 'package.json'), 'utf8')
      expect(official).not.toContain('@fixture/evil')
      expect(official).toContain(PACKAGE_MARKER)
      expect(await labExists(seeded.home, result.labId)).toBe(false)
      const entries = (await readFile(journalPath(seeded.home), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'restore',
        snapshotId: seeded.snapshotId,
        outcome: 'committed',
        preSnapshot: result.preSnapshot,
        afterSnapshot: result.afterSnapshot,
      })
    } finally {
      await destroyTempHome(seeded.home)
    }
  })

  test('--promote of a lockfile-less snapshot commits and drops a stale official lockfile', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      // No lockfile: exactly the state of a freshly initialized profile.
      await writeProfile(home, 'web', {
        packageJson: profilePackageJson({ bundles: ['@deepseek-ai/dsh-base'] }),
      })
      const captured = await runCliIn({
        argv: ['snapshot', 'create'],
        home,
        env: {
          WORLD_LINE_DISABLE_KEYCHAIN: '1',
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
      })
      expect(captured.exitCode).toBe(0)
      const snapshotId = captured.stdout.split('\n')[0]?.replace('snapshot  ', '') ?? ''
      // A later promotion adds a lockfile to the official profile; the
      // snapshot predates it, so restoring must remove it again.
      const ctx = makeCtx(home, fakeBin, () => new Date('2026-09-04T12:00:00.000Z'))
      const { writeFile } = await import('node:fs/promises')
      const lockPath = join(home, 'profiles', 'web', 'pnpm-lock.yaml')
      await writeFile(lockPath, 'lockfileVersion: 5.3\n', 'utf8')
      const result = await runRestoreCommand(ctx, {
        snapshotId,
        promote: true,
        deps: makeDeps({ count: 0 }),
      })
      expect(result.ok).toBe(true)
      const { readFile } = await import('node:fs/promises')
      await expect(readFile(lockPath)).rejects.toThrow()
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a legacy snapshot with secret-skipped bytes is refused before any lab exists', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      await writeProfile(home, 'web', {
        packageJson: profilePackageJson({ bundles: ['@deepseek-ai/dsh-base'] }),
        patchYaml: '- id: gate\n  config:\n    apiKey: sk-1234567890abcdef\n',
        lockfile: minimalLockfile('@deepseek-ai/dsh-base', '0.1.0'),
      })
      const captured = await runCliIn({
        argv: ['snapshot', 'create'],
        home,
        env: { WORLD_LINE_DISABLE_KEYCHAIN: '1', PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      })
      expect(captured.exitCode).toBe(0)
      const snapshotId = captured.stdout.split('\n')[0]?.replace('snapshot  ', '') ?? ''
      const manifest = JSON.parse(
        await readFile(snapshotManifestPath(home, snapshotId), 'utf8'),
      ) as SnapshotManifest
      expect(manifest.secretsBundle).toBeNull()
      const ctx = makeCtx(home, fakeBin, () => new Date('2026-09-04T12:00:00.000Z'))
      await expect(
        runRestoreCommand(ctx, { snapshotId, deps: makeDeps({ count: 0 }) }),
      ).rejects.toThrow(/has no stored bytes/)
      // No lab dir was created for the refused restore.
      const { readdir } = await import('node:fs/promises')
      const labs = await readdir(join(home, 'world-line', 'labs')).catch(() => [])
      expect(labs).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })
})
