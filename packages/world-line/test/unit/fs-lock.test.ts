/**
 * Path resolution, profile-name validation, atomic writes, and the
 * per-profile writer lock (acceptance 9: a live lock is never overridden; a
 * stale lock is only removed on explicit confirmation).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import { LockedError, UsageError } from '../../src/domain/errors.js'
import { writeFileAtomic } from '../../src/fs/atomic.js'
import { acquireLock, isProcessAlive, isStaleLock, readLock } from '../../src/fs/lock.js'
import {
  assertValidProfileName,
  profileDir,
  profileLockPath,
  resolveDshHome,
  worldLineDir,
} from '../../src/fs/paths.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wl-test-'))
}

describe('resolveDshHome', () => {
  test('prefers the explicit home over DSH_HOME and the default', () => {
    const home = resolveDshHome('/explicit', { DSH_HOME: '/from-env' })
    expect(home).toBe('/explicit')
  })

  test('falls back from DSH_HOME to the user home', () => {
    const fromEnv = resolveDshHome(undefined, { DSH_HOME: '/from-env' })
    expect(fromEnv).toBe('/from-env')
    const blankEnv = resolveDshHome(undefined, { DSH_HOME: '   ' })
    expect(blankEnv.endsWith('/.dsh')).toBe(true)
    const noEnv = resolveDshHome(undefined, {})
    expect(noEnv.endsWith('/.dsh')).toBe(true)
  })

  test('resolves relative explicit homes against cwd semantics', () => {
    const home = resolveDshHome('relative/path', {})
    expect(home.endsWith('relative/path')).toBe(true)
    expect(home.startsWith('/')).toBe(true)
  })
})

describe('assertValidProfileName', () => {
  test('rejects forbidden and path-shaped names', () => {
    for (const name of ['', '.', '..', 'node_modules', 'a/b', 'a\\b', 'a\u0000b']) {
      expect(() => assertValidProfileName(name)).toThrow(UsageError)
    }
  })

  test('accepts ordinary names', () => {
    expect(() => assertValidProfileName('web')).not.toThrow()
    expect(() => assertValidProfileName('my-test.profile')).not.toThrow()
  })
})

describe('path helpers', () => {
  test('lay out the store under the home', () => {
    const home = '/tmp/home'
    expect(profileDir(home, 'web')).toBe('/tmp/home/profiles/web')
    expect(worldLineDir(home)).toBe('/tmp/home/world-line')
    expect(profileLockPath(home, 'web')).toBe('/tmp/home/world-line/locks/web.lock')
  })
})

describe('writeFileAtomic', () => {
  test('writes and overwrites atomically', async () => {
    const dir = await tempDir()
    try {
      const file = join(dir, 'target.txt')
      await writeFileAtomic(file, 'one')
      expect(await readFile(file, 'utf8')).toBe('one')
      await writeFileAtomic(file, 'two')
      expect(await readFile(file, 'utf8')).toBe('two')
      const leftovers = (await import('node:fs/promises')).readdir(dir)
      expect(await leftovers).toEqual(['target.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('writer lock', () => {
  test('acquire and release round trip', async () => {
    const dir = await tempDir()
    try {
      const lockPath = join(dir, 'web.lock')
      const handle = await acquireLock({
        lockPath,
        purpose: 'test',
        now: new Date('2026-01-01T00:00:00Z'),
      })
      expect(handle.record.pid).toBe(process.pid)
      const content = await readLock(lockPath)
      expect(content?.token).toBe(handle.record.token)
      await handle.release()
      expect(await readLock(lockPath)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a live lock is never overridden, even with breakStale', async () => {
    const dir = await tempDir()
    try {
      const lockPath = join(dir, 'web.lock')
      const handle = await acquireLock({ lockPath, purpose: 'first', now: new Date() })
      await expect(
        acquireLock({ lockPath, purpose: 'second', breakStale: true, now: new Date() }),
      ).rejects.toThrow(LockedError)
      await handle.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a stale lock is refused without confirmation and broken with it', async () => {
    const dir = await tempDir()
    try {
      const lockPath = join(dir, 'web.lock')
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 2147483647, // far beyond any real pid: dead on this host
          host: hostname(),
          startedAt: '2020-01-01T00:00:00Z',
          purpose: 'crashed writer',
          token: 'old-token',
        }),
      )
      await expect(acquireLock({ lockPath, purpose: 'new', now: new Date() })).rejects.toThrow(
        LockedError,
      )
      const handle = await acquireLock({
        lockPath,
        purpose: 'new',
        breakStale: true,
        now: new Date(),
      })
      await handle.release()
      expect(await readLock(lockPath)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('concurrent acquisitions race cleanly: exactly one writer wins', async () => {
    const dir = await tempDir()
    try {
      const lockPath = join(dir, 'web.lock')
      const now = new Date()
      const attempts = await Promise.allSettled([
        acquireLock({ lockPath, purpose: 'racer-a', now }),
        acquireLock({ lockPath, purpose: 'racer-b', now }),
      ])
      const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
      const losers = attempts.filter((attempt) => attempt.status === 'rejected')
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0]?.reason).toBeInstanceOf(LockedError)
      // The surviving lock belongs to the winner and is released exactly once.
      const winner = winners[0]?.status === 'fulfilled' ? winners[0].value : undefined
      expect(winner).toBeDefined()
      expect(await readLock(lockPath)).not.toBeNull()
      await winner?.release()
      expect(await readLock(lockPath)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('release never removes a successor lock', async () => {
    const dir = await tempDir()
    try {
      const lockPath = join(dir, 'web.lock')
      const first = await acquireLock({ lockPath, purpose: 'first', now: new Date() })
      // Simulate a stale takeover by a later writer with a new token.
      await rm(lockPath)
      const second = await acquireLock({
        lockPath,
        purpose: 'second',
        breakStale: true,
        now: new Date(),
      })
      await first.release()
      expect(await readLock(lockPath)).not.toBeNull()
      await second.release()
      expect(await readLock(lockPath)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('lock helpers', () => {
  test('isProcessAlive sees this process and rejects dead pids', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2147483647)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })

  test('isStaleLock treats a dead holder and foreign hosts as stale', () => {
    const dead = { host: hostname(), pid: 2147483647, startedAt: '', purpose: '', token: '' }
    expect(isStaleLock(dead, new Date())).toBe(true)
    const foreign = { ...dead, host: 'elsewhere', pid: process.pid }
    expect(isStaleLock(foreign, new Date())).toBe(true)
    const live = { host: hostname(), pid: process.pid, startedAt: '', purpose: '', token: '' }
    expect(isStaleLock(live, new Date())).toBe(false)
    expect(isStaleLock(null, new Date())).toBe(false)
  })
})
