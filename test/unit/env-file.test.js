import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isEnvName,
  resolveDshHome,
  resolveEnvPath,
  upsertEnvAssignment,
  writeEnvAssignment,
} from '../../src/env-file.js'

/** A scratch directory removed when `body` finishes. */
async function withTempDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-test-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('DSH_HOME wins over the default when set', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/opt/dsh' }), '/opt/dsh')
  assert.equal(resolveEnvPath({ DSH_HOME: '/opt/dsh' }), '/opt/dsh/.env')
})

test('a blank or absent DSH_HOME falls back to ~/.dsh', () => {
  const expected = join(homedir(), '.dsh')
  assert.equal(resolveDshHome({}), expected)
  assert.equal(resolveDshHome({ DSH_HOME: '' }), expected)
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), expected)
  assert.equal(resolveEnvPath({}), join(expected, '.env'))
})

test('upsert writes the assignment into an empty file', () => {
  assert.equal(upsertEnvAssignment('', 'KEY', 'value'), 'KEY=value\n')
})

test('upsert replaces a prior assignment and preserves every other line', () => {
  const before = 'DSH_PORT=8080\nKEY=old\n# a note\nOTHER=1\n'
  const after = upsertEnvAssignment(before, 'KEY', 'new')
  assert.equal(after, 'DSH_PORT=8080\n# a note\nOTHER=1\nKEY=new\n')
})

test('upsert replaces every prior occurrence of the key', () => {
  const after = upsertEnvAssignment('KEY=one\nKEY=two\n', 'KEY', 'three')
  assert.equal(after, 'KEY=three\n')
})

test('upsert leaves commented and prefixed forms of the key alone', () => {
  // These are not what the runtime reads, and silently deleting an operator's
  // notes is worse than leaving a stale comment behind.
  const before = '#KEY=old\n  KEY=indented\nKEYRING=x\nKEY=live\n'
  const after = upsertEnvAssignment(before, 'KEY', 'new')
  assert.equal(after, '#KEY=old\n  KEY=indented\nKEYRING=x\nKEY=new\n')
})

test('upsert normalizes trailing blank lines and CRLF input', () => {
  assert.equal(upsertEnvAssignment('A=1\r\nB=2\r\n\r\n\r\n', 'C', '3'), 'A=1\nB=2\nC=3\n')
  assert.equal(upsertEnvAssignment('A=1\n\n\n', 'A', '2'), 'A=2\n')
})

test('writeEnvAssignment creates the file at 0600', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, '.env')
    assert.equal(await writeEnvAssignment({ path, key: 'K', value: 'v' }), path)
    assert.equal(await readFile(path, 'utf8'), 'K=v\n')
    // A verifier readable by anyone else on the box is a leaked credential.
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  })
})

test('writeEnvAssignment tightens the mode of a too-permissive existing file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, '.env')
    await writeFile(path, 'EXISTING=1\n', { mode: 0o644 })
    await writeEnvAssignment({ path, key: 'K', value: 'v' })
    assert.equal(await readFile(path, 'utf8'), 'EXISTING=1\nK=v\n')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  })
})

test('writeEnvAssignment leaves no temporary file behind', async () => {
  await withTempDir(async (dir) => {
    await writeEnvAssignment({ path: join(dir, '.env'), key: 'K', value: 'v' })
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual((await readdir(dir)).sort(), ['.env'])
  })
})

test('writeEnvAssignment refuses to write through a symlink', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'elsewhere')
    const path = join(dir, '.env')
    await writeFile(target, 'ORIGINAL\n')
    await symlink(target, path)
    // Following a planted link would write the secret wherever it points.
    await assert.rejects(
      writeEnvAssignment({ path, key: 'K', value: 'v' }),
      /refusing to write through a symlink/,
    )
    assert.equal(await readFile(target, 'utf8'), 'ORIGINAL\n')
  })
})

test('writeEnvAssignment surfaces a failure instead of truncating the file', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'missing-dir', '.env')
    await assert.rejects(writeEnvAssignment({ path, key: 'K', value: 'v' }), { code: 'ENOENT' })
  })
})

test('environment names use a portable identifier grammar', () => {
  for (const name of ['LOGIN_PASSWORD_HASH', '_private', 'A1']) {
    assert.equal(isEnvName(name), true, name)
  }
  for (const name of ['', '1FIRST', 'HAS-DASH', 'HAS SPACE', 'HAS=EQUALS', 'HAS\nNEWLINE']) {
    assert.equal(isEnvName(name), false, JSON.stringify(name))
  }
})

test('upsert refuses key or value injection', () => {
  assert.throws(() => upsertEnvAssignment('A=1\n', 'EVIL\nINJECTED', 'v'), /variable name/)
  assert.throws(() => upsertEnvAssignment('A=1\n', 'SAFE', 'v\nINJECTED=1'), /must be one line/)
  assert.throws(() => upsertEnvAssignment(undefined, 'SAFE', 'v'), /content must be a string/)
})
