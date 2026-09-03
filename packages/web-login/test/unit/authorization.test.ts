import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import {
  createOwnerDocument,
  digestToken,
  findActiveUser,
  loadAuthStartupState,
  mintRecoveryToken,
  parseAuthorizationDocument,
  resolveLifecycle,
  saveAuthorizationDocument,
  saveRecoveryRecord,
  touchLastLogin,
} from '../../src/authorization.js'

test('parseAuthorizationDocument accepts a valid owner document', () => {
  const document = createOwnerDocument({ githubUserId: 1, login: 'owner', enrolledAt: '2026-01-01T00:00:00.000Z' })
  const raw = `${JSON.stringify(document)}\n`
  const parsed = parseAuthorizationDocument(raw)
  expect(parsed).toEqual({ ok: true, document })
})

test('parseAuthorizationDocument rejects duplicates, missing owners, and bad schema', () => {
  const enrolledAt = '2026-01-01T00:00:00.000Z'
  expect(
    parseAuthorizationDocument(
      JSON.stringify({
        schemaVersion: 1,
        authzVersion: 1,
        users: [
          { githubUserId: 1, login: 'a', role: 'owner', status: 'active', enrolledAt },
          { githubUserId: 1, login: 'b', role: 'member', status: 'active', enrolledAt },
        ],
      }),
    ).ok,
  ).toBe(false)
  expect(
    parseAuthorizationDocument(
      JSON.stringify({
        schemaVersion: 1,
        authzVersion: 1,
        users: [{ githubUserId: 1, login: 'a', role: 'member', status: 'active', enrolledAt }],
      }),
    ).ok,
  ).toBe(false)
  expect(parseAuthorizationDocument(JSON.stringify({ schemaVersion: 99, authzVersion: 1, users: [] })).ok).toBe(
    false,
  )
})

test('resolveLifecycle distinguishes bootstrap, active, recovery, and invalid', () => {
  const enrolledAt = '2026-01-01T00:00:00.000Z'
  const owner = createOwnerDocument({ githubUserId: 1, login: 'owner', enrolledAt })
  expect(resolveLifecycle(null, null)).toBe('bootstrap')
  expect(resolveLifecycle(owner, null)).toBe('active')
  expect(
    resolveLifecycle(owner, {
      tokenDigest: 'a'.repeat(64),
      createdAt: enrolledAt,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  ).toBe('recovery')
  expect(
    resolveLifecycle(
      {
        schemaVersion: 1,
        authzVersion: 1,
        users: [{ githubUserId: 1, login: 'a', role: 'owner', status: 'disabled', enrolledAt }],
      },
      null,
    ),
  ).toBe('invalid')
})

test('findActiveUser and touchLastLogin operate on the numeric id', () => {
  const document = createOwnerDocument({
    githubUserId: 7,
    login: 'old',
    enrolledAt: '2026-01-01T00:00:00.000Z',
  })
  expect(findActiveUser(document, 7)?.login).toBe('old')
  expect(findActiveUser(document, 8)).toBeUndefined()
  const touched = touchLastLogin(document, 7, '2026-02-01T00:00:00.000Z')
  expect(touched.users[0]?.lastLoginAt).toBe('2026-02-01T00:00:00.000Z')
})

test('authorization writes are atomic and mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-authz-'))
  try {
    const path = join(dir, 'github-users.json')
    const document = createOwnerDocument({
      githubUserId: 3,
      login: 'owner',
      enrolledAt: '2026-01-01T00:00:00.000Z',
    })
    await saveAuthorizationDocument(path, document)
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual(document)
    const startup = loadAuthStartupState(path, join(dir, 'recovery.json'))
    expect(startup.lifecycle).toBe('active')
    expect(startup.document?.users[0]?.githubUserId).toBe(3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('symlink authorization files are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-authz-link-'))
  try {
    const target = join(dir, 'real.json')
    const link = join(dir, 'github-users.json')
    await writeFile(target, '{"schemaVersion":1,"authzVersion":1,"users":[]}\n')
    await symlink(target, link)
    const startup = loadAuthStartupState(link, join(dir, 'recovery.json'))
    expect(startup.lifecycle).toBe('invalid')
    expect(startup.error).toMatch(/symlink/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recovery token digests are hex sha256', async () => {
  const { token, digest } = mintRecoveryToken()
  expect(digest).toBe(digestToken(token))
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-recovery-'))
  try {
    const path = join(dir, 'recovery.json')
    await saveRecoveryRecord(path, {
      tokenDigest: digest,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const startup = loadAuthStartupState(join(dir, 'missing.json'), path)
    expect(startup.lifecycle).toBe('recovery')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
