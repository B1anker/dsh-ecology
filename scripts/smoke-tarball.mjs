/**
 * Prove a published tarball runs on the oldest Node it claims to support.
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
 * Which package it received is read from the tarball rather than passed in, so
 * a caller cannot accidentally run one package's assertions against another's
 * artifact and get a pass out of it.
 *
 * Usage: node scripts/smoke-tarball.mjs <path-to-tarball>
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, execPath, exit, version } from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * What to check for each package, and what not to import.
 *
 * `skip` names modules that cannot be imported in a directory with no
 * `node_modules`, because they import an optional peer. Excluding one is a
 * deliberate statement that it is not part of the package's cold-start surface,
 * not a way to quiet a failure.
 */
const PACKAGES = {
  '@seaveyon/dsh-web-login': {
    skip: ['hash-password.js'],
    /**
     * @param dist - file URL of the extracted `dist/` directory.
     * @param root - filesystem path of the extracted package.
     * @returns a description of what was exercised.
     */
    async check(dist, root) {
      const { apply, inject, name, READY_SERVICE } = await import(new URL('index.js', dist).href)
      if (typeof apply !== 'function') throw new Error('apply is not a function')
      if (name !== 'dsh-web-login') throw new Error(`name is ${name}`)
      if (!Array.isArray(inject)) throw new Error('inject is not an array')
      if (READY_SERVICE !== 'dshWebLoginReady') throw new Error(`READY_SERVICE is ${READY_SERVICE}`)

      // The scrypt round trip is the part most likely to break on an old
      // runtime: it is the only place the package calls into crypto with its
      // own parameters, and it uses both the callback and the sync form.
      const { hashPassword, parseVerifier, verifyPassword } = await import(
        new URL('verifier.js', dist).href
      )
      const stored = hashPassword('correct horse battery staple')
      if (!/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(stored)) throw new Error('verifier format')
      const verifier = parseVerifier(stored)
      if (verifier === null) throw new Error('parseVerifier rejected its own output')
      if ((await verifyPassword('correct horse battery staple', verifier)) !== true) {
        throw new Error('the right password was refused')
      }
      if ((await verifyPassword('wrong', verifier)) !== false) {
        throw new Error('a wrong password was accepted')
      }
      if (parseVerifier('scrypt$nothex$alsonothex') !== null) {
        throw new Error('parseVerifier accepted a malformed value')
      }

      const { renderLoginPage } = await import(new URL('page.js', dist).href)
      if (!renderLoginPage({ title: 'T' }).includes('<!doctype html>')) {
        throw new Error('page render')
      }

      const { serializeSessionCookie } = await import(new URL('cookies.js', dist).href)
      const cookie = serializeSessionCookie('abc', { maxAgeSeconds: 60, secure: true })
      if (!cookie.includes('HttpOnly')) throw new Error('cookie lost HttpOnly')
      // The prefix is a browser-enforced scoping rule, so losing it in a build
      // would weaken the session silently rather than break anything.
      if (!cookie.startsWith('__Host-')) throw new Error('secure cookie lost its __Host- prefix')

      const cli = join(root, 'dist', 'hash-password.js')
      const { stdout } = await run(execPath, [cli, '--help'])
      if (!stdout.startsWith('Usage: dsh-web-login-hash')) throw new Error('CLI --help')

      return 'scrypt round trip, render, cookie, CLI'
    },
  },

  '@seaveyon/dsh-plugin-testkit': {
    // The contract suite declares tests, so it imports @rstest/core — an
    // optional peer that is deliberately absent here. Everything a consumer can
    // use without a runner is in the main entry, which is what this imports.
    skip: ['contract.js'],
    /**
     * @param dist - file URL of the extracted `dist/` directory.
     * @returns a description of what was exercised.
     */
    async check(dist) {
      const { createMockContext, createMockWebServer, fakeRequest, fakeResponse } = await import(
        new URL('index.js', dist).href
      )

      const web = createMockWebServer()
      const ctx = createMockContext({ webServer: web.service })
      if (ctx.get('webServer') !== web.service) throw new Error('context lost its service')

      const dispose = web.service.register({
        kind: 'exact',
        path: '/x',
        handler: () => undefined,
      })
      if (typeof dispose !== 'function') throw new Error('register returned no disposer')
      dispose()

      // A real socket, because a mock HTTP registry that has only ever been
      // exercised in memory is not evidence of anything.
      const port = await web.listen()
      if (typeof port !== 'number') throw new Error('listen returned no port')
      await web.close()

      const req = fakeRequest({ headers: { 'X-Test': '1' } })
      if (req.headers['x-test'] !== '1') throw new Error('fakeRequest lost a header')
      const res = fakeResponse()
      res.writeHead(204, {})
      res.end()
      if (res.status !== 204) throw new Error('fakeResponse lost its status')

      return 'mock registry over a real socket, context, request and response doubles'
    },
  },
}

const tarball = argv[2]
if (tarball === undefined) {
  console.error('usage: node scripts/smoke-tarball.mjs <path-to-tarball>')
  exit(2)
}

const work = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
try {
  await run('tar', ['-xzf', tarball, '-C', work])
  const root = join(work, 'package')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const entry = PACKAGES[manifest.name]
  if (entry === undefined) {
    throw new Error(`no smoke checks are defined for ${manifest.name}`)
  }

  const dist = pathToFileURL(join(root, 'dist') + '/')

  // Import order is alphabetical rather than dependency-led: any module that
  // only loads because something else loaded first is a module with an
  // undeclared dependency, and importing each one cold is how that shows up.
  const modules = (await readdir(dist)).filter(
    (file) => file.endsWith('.js') && !entry.skip.includes(file),
  )
  for (const file of modules.toSorted()) await import(new URL(file, dist).href)

  const exercised = await entry.check(dist, root)
  console.log(`ok on ${version}: ${manifest.name}, ${modules.length} modules, ${exercised}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
