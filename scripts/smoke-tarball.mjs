/**
 * Prove the published tarball runs on the oldest Node it claims to support.
 *
 * The rest of CI cannot answer this. rslib, rstest, and the rsbuild beneath both
 * require Node `^20.19.0 || >=22.12.0`, so no job that installs the dev toolchain
 * can start on the 20.11 that `engines.node` promises. This script therefore
 * takes the packed tarball, extracts it somewhere with no node_modules at all,
 * and imports it the way a consumer would.
 *
 * It is plain JavaScript on purpose: running it under the old Node is the point,
 * and a TypeScript entry would need a loader that has its own version floor.
 *
 * Usage: node scripts/smoke-tarball.mjs <path-to-tarball>
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, execPath, exit, version } from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const tarball = argv[2]
if (tarball === undefined) {
  console.error('usage: node scripts/smoke-tarball.mjs <path-to-tarball>')
  exit(2)
}

const work = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
try {
  await run('tar', ['-xzf', tarball, '-C', work])
  const dist = pathToFileURL(join(work, 'package', 'dist') + '/')

  // Import order is alphabetical rather than dependency-led: any module that
  // only loads because something else loaded first is a module with an
  // undeclared dependency, and importing each one cold is how that shows up.
  const modules = (await readdir(dist)).filter(
    (file) => file.endsWith('.js') && file !== 'hash-password.js',
  )
  for (const file of modules.toSorted()) await import(new URL(file, dist).href)

  const { apply, inject, name, READY_SERVICE } = await import(new URL('index.js', dist).href)
  if (typeof apply !== 'function') throw new Error('apply is not a function')
  if (name !== 'dsh-web-login') throw new Error(`name is ${name}`)
  if (!Array.isArray(inject)) throw new Error('inject is not an array')
  if (READY_SERVICE !== 'dshWebLoginReady') throw new Error(`READY_SERVICE is ${READY_SERVICE}`)

  // The scrypt round trip is the part most likely to break on an old runtime:
  // it is the only place the package calls into crypto with its own parameters.
  const { hashPassword, parseVerifier, verifyPassword } = await import(
    new URL('verifier.js', dist).href
  )
  const stored = hashPassword('correct horse battery staple')
  if (!/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(stored)) throw new Error('verifier format')
  const verifier = parseVerifier(stored)
  if (verifier === null) throw new Error('parseVerifier rejected its own output')
  if (verifyPassword('correct horse battery staple', verifier) !== true) {
    throw new Error('the right password was refused')
  }
  if (verifyPassword('wrong', verifier) !== false) {
    throw new Error('a wrong password was accepted')
  }
  if (parseVerifier('scrypt$nothex$alsonothex') !== null) {
    throw new Error('parseVerifier accepted a malformed value')
  }

  const { renderLoginPage } = await import(new URL('page.js', dist).href)
  if (!renderLoginPage({ title: 'T' }).includes('<!doctype html>')) throw new Error('page render')

  const { serializeSessionCookie } = await import(new URL('cookies.js', dist).href)
  const cookie = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
  if (!cookie.includes('HttpOnly')) throw new Error('cookie lost HttpOnly')

  const cli = join(work, 'package', 'dist', 'hash-password.js')
  const { stdout } = await run(execPath, [cli, '--help'])
  if (!stdout.startsWith('Usage: dsh-web-login-hash')) throw new Error('CLI --help')

  console.log(`ok on ${version}: ${modules.length} modules, scrypt round trip, render, cookie, CLI`)
} finally {
  await rm(work, { recursive: true, force: true })
}
