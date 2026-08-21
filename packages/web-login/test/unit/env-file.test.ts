import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@rstest/core'
import {
  isEnvName,
  resolveDshHome,
  resolveEnvPath,
  upsertEnvAssignment,
  writeEnvAssignment,
} from '../../src/env-file.js'

/**
 * Run `body` against a scratch directory, removed afterwards.
 * @param body - receives the directory path.
 */
async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-test-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('DSH_HOME wins over the default when set', () => {
  expect(resolveDshHome({ DSH_HOME: '/opt/dsh' })).toBe('/opt/dsh')
  expect(resolveEnvPath({ DSH_HOME: '/opt/dsh' })).toBe('/opt/dsh/.env')
})

test('a blank or absent DSH_HOME falls back to ~/.dsh', () => {
  const expected = join(homedir(), '.dsh')
  expect(resolveDshHome({})).toBe(expected)
  expect(resolveDshHome({ DSH_HOME: '' })).toBe(expected)
  expect(resolveDshHome({ DSH_HOME: '   ' })).toBe(expected)
  expect(resolveEnvPath({})).toBe(join(expected, '.env'))
})

test('upsert writes the assignment into an empty file', () => {
  expect(upsertEnvAssignment('', 'KEY', 'value')).toBe('KEY=value\n')
})

test('upsert replaces a prior assignment and preserves every other line', () => {
  const before = 'DSH_PORT=8080\nKEY=old\n# a note\nOTHER=1\n'
  expect(upsertEnvAssignment(before, 'KEY', 'new')).toBe(
    'DSH_PORT=8080\n# a note\nOTHER=1\nKEY=new\n',
  )
})

test('upsert replaces every prior occurrence of the key', () => {
  expect(upsertEnvAssignment('KEY=one\nKEY=two\n', 'KEY', 'three')).toBe('KEY=three\n')
})

test('upsert leaves commented and prefixed forms of the key alone', () => {
  // These are not what the runtime reads, and silently deleting an operator's
  // notes is worse than leaving a stale comment behind.
  const before = '#KEY=old\n  KEY=indented\nKEYRING=x\nKEY=live\n'
  expect(upsertEnvAssignment(before, 'KEY', 'new')).toBe(
    '#KEY=old\n  KEY=indented\nKEYRING=x\nKEY=new\n',
  )
})

test('upsert normalizes trailing blank lines and CRLF input', () => {
  expect(upsertEnvAssignment('A=1\r\nB=2\r\n\r\n\r\n', 'C', '3')).toBe('A=1\nB=2\nC=3\n')
  expect(upsertEnvAssignment('A=1\n\n\n', 'A', '2')).toBe('A=2\n')
})

test('writeEnvAssignment creates the file at 0600', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, '.env')
    expect(await writeEnvAssignment({ path, key: 'K', value: 'v' })).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('K=v\n')
    // A verifier readable by anyone else on the box is a leaked credential.
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test('writeEnvAssignment tightens the mode of a too-permissive existing file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, '.env')
    await writeFile(path, 'EXISTING=1\n', { mode: 0o644 })
    await writeEnvAssignment({ path, key: 'K', value: 'v' })
    expect(await readFile(path, 'utf8')).toBe('EXISTING=1\nK=v\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

test('writeEnvAssignment leaves no temporary file behind', async () => {
  await withTempDir(async (dir) => {
    await writeEnvAssignment({ path: join(dir, '.env'), key: 'K', value: 'v' })
    // The write goes through mkdtemp + rename; a leftover temp file would hold a
    // verifier at whatever mode the temp directory happened to give it.
    expect((await readdir(dir)).toSorted()).toEqual(['.env'])
  })
})

test('writeEnvAssignment refuses to write through a symlink', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'elsewhere')
    const path = join(dir, '.env')
    await writeFile(target, 'ORIGINAL\n')
    await symlink(target, path)
    // Following a planted link would write the secret wherever it points.
    await expect(writeEnvAssignment({ path, key: 'K', value: 'v' })).rejects.toThrow(
      /refusing to write through a symlink/,
    )
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL\n')
  })
})

test('writeEnvAssignment surfaces a failure instead of truncating the file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'missing-dir', '.env')
    await expect(writeEnvAssignment({ path, key: 'K', value: 'v' })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

test('environment names use a portable identifier grammar', () => {
  for (const name of ['LOGIN_PASSWORD_HASH', '_private', 'A1']) {
    expect(isEnvName(name), name).toBe(true)
  }
  for (const name of ['', '1FIRST', 'HAS-DASH', 'HAS SPACE', 'HAS=EQUALS', 'HAS\nNEWLINE']) {
    expect(isEnvName(name), JSON.stringify(name)).toBe(false)
  }
})

test('upsert refuses key or value injection', () => {
  expect(() => upsertEnvAssignment('A=1\n', 'EVIL\nINJECTED', 'v')).toThrow(/variable name/)
  expect(() => upsertEnvAssignment('A=1\n', 'SAFE', 'v\nINJECTED=1')).toThrow(/must be one line/)
  // The parameters are `unknown` because a caller may pass through a value it
  // read from a file; undefined content must fail loudly, not concatenate.
  expect(() => upsertEnvAssignment(undefined, 'SAFE', 'v')).toThrow(/content must be a string/)
})
