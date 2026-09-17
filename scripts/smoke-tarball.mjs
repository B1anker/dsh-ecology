/**
 * Prove a published tarball runs on the oldest Node it claims to support.
 *
 * The rest of CI cannot answer this. rslib, rstest, and the rsbuild beneath both
 * require Node `^20.19.0 || >=22.12.0`, so no job that installs the dev toolchain
 * can start on the 20.11 that `engines.node` promises. This script therefore
 * takes the packed tarball, extracts it somewhere without the workspace
 * toolchain, installs only what the package needs at load time (its production
 * dependencies, and the host packages its entry imports), and imports it the
 * way a consumer would.
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
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { argv, execPath, exit, version } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { load } from 'js-yaml'

const run = promisify(execFile)

/**
 * What to check for each package, and what not to import.
 *
 * `skip` names modules that cannot be imported in a directory with no
 * `node_modules`, because they import an optional peer. Excluding one is a
 * deliberate statement that it is not part of the package's cold-start surface,
 * not a way to quiet a failure.
 *
 * `peers(manifest)` names host packages to install beside the extracted
 * tarball before importing. A plugin whose public entry imports a host
 * package at load time cannot be cold-imported without it — and a consumer
 * never is, because the host that loads the plugin carries the package. The
 * spec comes from the manifest so the smoke exercises the copy the package is
 * developed against rather than a version repeated here.
 */
const PACKAGES = {
  '@seaveyon/dsh-git-worktree': {
    // `dist/index.js` imports `defineTool` from the host's tools package at
    // load time (the tools are defined at module evaluation). The rest of the
    // ESM output is the browser bundle's source emitted alongside; those
    // modules import react / the shell primitives and are exercised through
    // `dist/client.js` in a browser, not here.
    peers: (manifest) => [
      `@deepseek-ai/dsh-tools@${manifest.devDependencies['@deepseek-ai/dsh-tools']}`,
    ],
    skip: [
      'client.js',
      'strings.js',
      'sidebar-worktree-grouper.js',
      'worktree-control.js',
      'worktree-removal-modal.js',
    ],
    /**
     * @param _dist - file URL of the extracted `dist/` directory.
     * @param root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @param manifest - extracted package.json.
     * @returns a description of what was exercised.
     */
    async check(_dist, root, entry, manifest) {
      const { apply, inject, name, assertBranchName, GitWorktreeError } = entry
      if (typeof apply !== 'function') throw new Error('apply is not a function')
      if (name !== 'dsh-git-worktree') throw new Error(`name is ${name}`)
      if (JSON.stringify(inject) !== JSON.stringify(['tools', 'webServer', 'connection'])) {
        throw new Error(`inject is ${JSON.stringify(inject)}`)
      }
      if (typeof assertBranchName !== 'function') throw new Error('assertBranchName missing')
      let refused = false
      try {
        assertBranchName('-not/a..branch')
      } catch (error) {
        refused = error instanceof GitWorktreeError
      }
      if (!refused) throw new Error('assertBranchName accepted an invalid branch name')

      // The management API must not come up without the host's fence: apply
      // refuses when `connection` is absent and registers nothing.
      const registered = []
      let threw = null
      try {
        apply({
          tools: { register() {} },
          get: (service) =>
            service === 'webServer'
              ? {
                  register(route) {
                    registered.push(route.path)
                    return () => {}
                  },
                }
              : undefined,
          effect(fn) {
            fn()
          },
        })
      } catch (error) {
        threw = error
      }
      if (!(threw instanceof Error) || !/connection service missing/.test(threw.message)) {
        throw new Error('apply ran without a connection service')
      }
      if (registered.length !== 0) throw new Error('routes were registered unfenced')

      // With both services present every route registers through the fence.
      const paths = []
      apply({
        tools: { register() {} },
        get: (service) =>
          service === 'webServer'
            ? {
                register(route) {
                  paths.push(route.path)
                  return () => {}
                },
              }
            : service === 'connection'
              ? { requestRejection: () => 401 }
              : undefined,
        effect(fn) {
          fn()
        },
      })
      if (
        paths.length !== 6 ||
        !paths.every((p) => p.startsWith('/api/plugins/dsh-git-worktree/'))
      ) {
        throw new Error(`unexpected route table ${JSON.stringify(paths)}`)
      }

      const declaredPatch = manifest.dsh?.bundle?.patch
      if (declaredPatch !== './cordis.patch.yml') {
        throw new Error(`unexpected dsh.bundle.patch ${declaredPatch}`)
      }
      const patch = load(await readFile(join(root, declaredPatch), 'utf8'))
      if (!Array.isArray(patch)) throw new Error('bundle patch is not a top-level array')
      const inserted = patch.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
      const row = inserted.find((entry) => entry?.id === 'dsh-git-worktree')
      if (row?.name !== '@seaveyon/dsh-git-worktree') throw new Error('bundle plugin row')
      if (JSON.stringify(row.inject) !== JSON.stringify(['tools', 'webServer', 'connection'])) {
        throw new Error('bundle plugin row does not wait for tools, webServer, and connection')
      }

      if (manifest.exports?.['./client']?.default !== './dist/client.js') {
        throw new Error(
          `unexpected client export ${JSON.stringify(manifest.exports?.['./client'])}`,
        )
      }
      if (manifest.dsh?.client?.platform !== 'web' || manifest.dsh?.client?.immediately !== true) {
        throw new Error(`unexpected dsh.client ${JSON.stringify(manifest.dsh?.client)}`)
      }
      const clientBundle = await readFile(join(root, 'dist/client.js'), 'utf8')
      if (!clientBundle.startsWith('window.__ModuleLoader__.load')) {
        throw new Error('client bundle missing ModuleLoader envelope')
      }
      if (!clientBundle.includes('id: "@seaveyon/dsh-git-worktree"')) {
        throw new Error('client bundle registers the wrong module id')
      }
      if (!clientBundle.includes('require("react")')) {
        throw new Error('client bundle no longer externalizes react')
      }

      return 'public export over the real tools package, fence refusal and route table, bundle patch, client envelope'
    },
  },

  '@seaveyon/dsh-web-login': {
    // Browser client is a `__ModuleLoader__` envelope that expects `window`.
    // CLI bins are covered via `execFile`, not cold import.
    skip: ['hash-password.js', 'create-recovery.js', 'client.js'],
    /**
     * @param dist - file URL of the extracted `dist/` directory.
     * @param root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @param manifest - extracted package.json.
     * @returns a description of what was exercised.
     */
    async check(dist, root, entry, manifest) {
      const { apply, inject, name, READY_SERVICE } = entry
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

      const cliTarget = manifest.bin?.['dsh-web-login-hash']
      if (cliTarget !== './dist/hash-password.js')
        throw new Error(`unexpected bin target ${cliTarget}`)
      const cli = join(root, cliTarget)
      const { stdout } = await run(execPath, [cli, '--help'])
      if (!stdout.startsWith('Usage: dsh-web-login-hash')) throw new Error('CLI --help')

      const declaredPatch = manifest.dsh?.bundle?.patch
      if (declaredPatch !== './cordis.patch.yml') {
        throw new Error(`unexpected dsh.bundle.patch ${declaredPatch}`)
      }
      const patch = load(await readFile(join(root, declaredPatch), 'utf8'))
      if (!Array.isArray(patch)) throw new Error('bundle patch is not a top-level array')

      const inserted = patch.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
      const login = inserted.find((row) => row?.id === 'dsh-web-login')
      if (login?.name !== '@seaveyon/dsh-web-login') throw new Error('bundle plugin row')
      if (JSON.stringify(login.inject) !== JSON.stringify(['webServer'])) {
        throw new Error('bundle plugin row does not wait for webServer')
      }

      const expectedInject = {
        'web-runtime': ['webStartup', 'dshWebLoginReady'],
        connection: ['webRuntime', 'dshWebLoginReady'],
        modules: ['webServer', 'dshWebLoginReady'],
        'client-hmr': ['dshWebLoginReady'],
      }
      for (const [id, expected] of Object.entries(expectedInject)) {
        const actual = patch.find((item) => item?.id === id)?.inject
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`${id} inject is ${JSON.stringify(actual)}`)
        }
      }

      // Browser client: assert the published envelope without importing it under
      // Node (it starts with `window.__ModuleLoader__.load`).
      if (manifest.exports?.['./client']?.default !== './dist/client.js') {
        throw new Error(
          `unexpected client export ${JSON.stringify(manifest.exports?.['./client'])}`,
        )
      }
      if (manifest.dsh?.client?.platform !== 'web') {
        throw new Error(`unexpected dsh.client ${JSON.stringify(manifest.dsh?.client)}`)
      }
      const clientBundle = await readFile(join(root, 'dist/client.js'), 'utf8')
      if (!clientBundle.startsWith('window.__ModuleLoader__.load')) {
        throw new Error('client bundle missing ModuleLoader envelope')
      }

      return 'public export, bundle patch, scrypt round trip, render, cookie, bin CLI, client envelope'
    },
  },

  '@seaveyon/dsh-pet': {
    // client.js is a browser artifact: its first statement touches `window`,
    // so importing it in Node fails by design. It is exercised below as text
    // (envelope assertion) instead of as a module.
    skip: ['client.js'],
    /**
     * @param _dist - file URL of the extracted `dist/` directory.
     * @param root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @param manifest - extracted package.json.
     * @returns a description of what was exercised.
     */
    async check(_dist, root, entry, manifest) {
      const { apply, name } = entry
      if (typeof apply !== 'function') throw new Error('apply is not a function')
      if (name !== 'dsh-pet') throw new Error(`name is ${name}`)

      // The client bundle is the whole product; the host entry is a no-op that
      // exists so the Loader row has something to activate. What can be proven
      // here is the envelope the shell's module loader requires.
      const clientRel = manifest.exports?.['./client']?.default
      if (clientRel !== './dist/client.js') throw new Error(`./client export is ${clientRel}`)
      const bundle = await readFile(join(root, 'dist', 'client.js'), 'utf8')
      if (!bundle.startsWith('window.__ModuleLoader__.load({')) {
        throw new Error('client bundle lost its __ModuleLoader__ envelope')
      }
      // The shell rejects a bundle whose registration id differs from the
      // Loader entry name ("loaded without registering <id>"), and this is the
      // check that keeps a scoped rename from shipping that failure again.
      if (!bundle.includes('id: "@seaveyon/dsh-pet"')) {
        throw new Error('client bundle registers the wrong module id')
      }
      if (!bundle.includes('require("react")')) {
        throw new Error('client bundle no longer externalizes react')
      }

      const client = manifest.dsh?.client
      if (client?.platform !== 'web' || client?.immediately !== true) {
        throw new Error(`unexpected dsh.client declaration ${JSON.stringify(client)}`)
      }

      // The discovery row: without it the client module system never serves
      // the bundle, and the plugin is an invisible dependency.
      const declaredPatch = manifest.dsh?.bundle?.patch
      if (declaredPatch !== './cordis.patch.yml') {
        throw new Error(`unexpected dsh.bundle.patch ${declaredPatch}`)
      }
      const patch = load(await readFile(join(root, declaredPatch), 'utf8'))
      if (!Array.isArray(patch)) throw new Error('bundle patch is not a top-level array')
      const inserted = patch.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
      const pet = inserted.find((row) => row?.id === 'dsh-pet')
      if (pet?.name !== '@seaveyon/dsh-pet') throw new Error('bundle plugin row')

      // Nothing of the desktop app ships in this tarball: each binary rides in
      // its own per-platform optional package (@seaveyon/dsh-pet-desktop-*),
      // published alongside by the workflow, with the sprite assets beside it
      // at bin/assets/ (src/launch.ts points the spawn there). The files
      // allowlist names no desktop/ entry, so its presence here means a
      // staged build leaked back into the plugin — the regression that once
      // doubled every install, or re-added 7 MB of sprites the plugin itself
      // never reads.
      const leaked = await stat(join(root, 'desktop')).catch(() => null)
      if (leaked !== null) {
        throw new Error(
          'desktop/ is back in the main tarball; binaries and sprites belong to the platform packages',
        )
      }
      const platformPackages = Object.keys(manifest.optionalDependencies ?? {}).toSorted()
      const expectedPlatforms = [
        '@seaveyon/dsh-pet-desktop-darwin-arm64',
        '@seaveyon/dsh-pet-desktop-darwin-x64',
        '@seaveyon/dsh-pet-desktop-win32-x64',
      ]
      if (platformPackages.join(',') !== expectedPlatforms.join(',')) {
        throw new Error(
          `unexpected platform packages ${JSON.stringify(manifest.optionalDependencies)}`,
        )
      }
      for (const [platformPackage, range] of Object.entries(manifest.optionalDependencies)) {
        // Exact and equal to pet's own version: the /state contract between
        // the plugin and the binary is only checked by this lock-step.
        if (range !== manifest.version) {
          throw new Error(
            `${platformPackage} is pinned to ${range}, not pet's own ${manifest.version}`,
          )
        }
      }

      return 'public export, client bundle envelope, dsh.client manifest, discovery patch row, no desktop/ bytes, platform packages version-locked'
    },
  },

  '@seaveyon/dsh-di': {
    // No dependencies, no peers, no Node built-ins: every module cold-imports.
    skip: [],
    /**
     * @param _dist - file URL of the extracted `dist/` directory.
     * @param _root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @param manifest - extracted package.json.
     * @returns a description of what was exercised.
     */
    async check(_dist, _root, entry, manifest) {
      const {
        createDecorator,
        inject,
        optional,
        InstantiationService,
        IInstantiationService,
        ServiceCollection,
        SyncDescriptor,
        isDisposable,
      } = entry
      for (const [name, value] of Object.entries({
        createDecorator,
        inject,
        optional,
        InstantiationService,
        ServiceCollection,
        SyncDescriptor,
        isDisposable,
      })) {
        if (typeof value !== 'function') throw new Error(`${name} is not a function`)
      }
      if (String(IInstantiationService) !== 'instantiationService') {
        throw new Error('IInstantiationService lost its name')
      }

      // A small graph, resolved the way a plugin's apply() would: a ready host
      // instance, an eager recipe with a static argument, a delayed recipe, and
      // disposal in reverse order. Declared without decorator syntax because
      // this file is plain JavaScript — which is also the point: the published
      // package must not need a decorator transform to be *used*.
      const IHost = createDecorator('smoke.host')
      const IStore = createDecorator('smoke.store')
      const ILazy = createDecorator('smoke.lazy')
      const IMissing = createDecorator('smoke.missing')
      const log = []
      class Store {
        // Injected positions lead (host, then the optional one), statics follow.
        constructor(host, missing, path) {
          this.host = host
          this.missing = missing
          this.path = path
          log.push('create store')
        }
        dispose() {
          log.push('dispose store')
        }
      }
      inject(IHost, optional(IMissing))(Store)
      class Lazy {
        constructor(store) {
          this.store = store
          log.push('create lazy')
        }
        label() {
          return `lazy over ${this.store.path}`
        }
        dispose() {
          log.push('dispose lazy')
        }
      }
      inject(IStore)(Lazy)

      const host = { name: 'host' }
      const collection = new ServiceCollection([IHost, host])
      collection.set(IStore, new SyncDescriptor(Store, ['/tmp/store.json']))
      collection.set(ILazy, new SyncDescriptor(Lazy, [], true))
      const services = new InstantiationService(collection)
      if (services.get(IInstantiationService) !== services) throw new Error('self-registration')

      const lazy = services.get(ILazy)
      if (log.length !== 0) throw new Error('delayed service was built eagerly')
      if (lazy.label() !== 'lazy over /tmp/store.json') throw new Error('resolution through proxy')
      const store = services.get(IStore)
      if (store.host !== host) throw new Error('ready instance was not injected as-is')
      if (store.path !== '/tmp/store.json') throw new Error('static argument')
      if (store.missing !== undefined) throw new Error('optional position was not left undefined')
      if (services.get(IStore) !== store) throw new Error('singleton caching')
      if (!isDisposable(store)) throw new Error('isDisposable')

      let threw = null
      try {
        services.get(IMissing)
      } catch (error) {
        threw = error
      }
      if (!(threw instanceof Error) || !/'smoke.missing' is not registered/.test(threw.message)) {
        throw new Error('unregistered service did not throw by name')
      }

      services.dispose()
      if (
        JSON.stringify(log) !==
        JSON.stringify(['create store', 'create lazy', 'dispose lazy', 'dispose store'])
      ) {
        throw new Error(`disposal order ${JSON.stringify(log)}`)
      }
      if (Object.keys(manifest.dependencies ?? {}).length !== 0) {
        throw new Error('the container grew a runtime dependency')
      }

      return 'public export, a graph resolved without decorator syntax, laziness, optional, disposal order'
    },
  },

  '@seaveyon/dsh-plugin-testkit': {
    // The contract suites declare tests, so they import @rstest/core — an
    // optional peer that is deliberately absent here. Everything a consumer can
    // use without a runner is in the main entry, which is what this imports.
    skip: ['contract.js', 'contract-web-server.js', 'contract-context.js', 'contract-tools.js'],
    /**
     * @param dist - file URL of the extracted `dist/` directory.
     * @param _root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @returns a description of what was exercised.
     */
    async check(_dist, _root, entry) {
      const {
        createMockContext,
        createMockToolsPipeline,
        createMockWebServer,
        fakeRequest,
        fakeResponse,
      } = entry

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

      ctx.on('smoke', (value, next) => {
        const inner = next()
        return inner === undefined ? value : inner
      })
      if (ctx.waterfall('smoke', 7) !== 7) throw new Error('waterfall lost its payload')

      const tools = createMockToolsPipeline(ctx)
      tools.service.register('echo', (exec) => exec.arguments)
      ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'smoke' }))
      const denied = await tools.run({ name: 'echo', arguments: { ok: true } })
      if (!denied.isError || denied.content !== 'smoke') {
        throw new Error('tools pipeline deny failed')
      }

      return 'public export, mock registry over a real socket, context events, tools deny, request and response doubles'
    },
  },

  '@seaveyon/dsh-world-line': {
    // Browser client is a `__ModuleLoader__` envelope that expects `window`.
    skip: ['client.js'],
    /**
     * @param _dist - file URL of the extracted `dist/` directory.
     * @param root - filesystem path of the extracted package.
     * @param entry - package namespace resolved through the public exports map.
     * @param manifest - extracted package.json.
     * @returns a description of what was exercised.
     */
    async check(_dist, root, entry, manifest) {
      const {
        apply,
        inject,
        name,
        main,
        runCli,
        WORLD_LINE_VERSION,
        ENVELOPE_SCHEMA_VERSION,
        WORLD_LINE_FORMAT_VERSION,
      } = entry
      if (typeof apply !== 'function') throw new Error('apply is not a function')
      if (typeof main !== 'function') throw new Error('main is not a function')
      if (typeof runCli !== 'function') throw new Error('runCli is not a function')
      if (name !== '@seaveyon/dsh-world-line') throw new Error(`name is ${name}`)
      if (JSON.stringify(inject) !== JSON.stringify(['webServer', 'connection'])) {
        throw new Error(`inject is ${JSON.stringify(inject)}`)
      }
      if (WORLD_LINE_VERSION !== manifest.version) {
        throw new Error(`WORLD_LINE_VERSION ${WORLD_LINE_VERSION} != ${manifest.version}`)
      }
      if (ENVELOPE_SCHEMA_VERSION !== 1) throw new Error('envelope schema')
      if (WORLD_LINE_FORMAT_VERSION !== 1) throw new Error('format version')

      const webRel = manifest.exports?.['./web']?.default
      if (webRel !== './dist/web/index.js') throw new Error(`./web export is ${webRel}`)

      const cliTarget = manifest.bin?.['dsh-world-line']
      if (cliTarget !== './bin/dsh-world-line.mjs') {
        throw new Error(`unexpected bin target ${cliTarget}`)
      }
      if (manifest.bin?.['world-line'] !== cliTarget) {
        throw new Error('world-line bin alias does not match dsh-world-line')
      }
      const cli = join(root, cliTarget)
      const help = await run(execPath, [cli, '--help'])
      if (!help.stdout.startsWith(`dsh-world-line ${manifest.version}`)) {
        throw new Error('CLI --help')
      }
      const versionOut = await run(execPath, [cli, '--version'])
      if (versionOut.stdout.trim() !== manifest.version) throw new Error('CLI --version')

      const declaredPatch = manifest.dsh?.bundle?.patch
      if (declaredPatch !== './cordis.patch.yml') {
        throw new Error(`unexpected dsh.bundle.patch ${declaredPatch}`)
      }
      const patch = load(await readFile(join(root, declaredPatch), 'utf8'))
      if (!Array.isArray(patch)) throw new Error('bundle patch is not a top-level array')
      const inserted = patch.flatMap((item) => (Array.isArray(item?.insert) ? item.insert : []))
      const worldLine = inserted.find((row) => row?.id === 'world-line')
      if (worldLine?.name !== '@seaveyon/dsh-world-line') throw new Error('bundle plugin row')
      if (JSON.stringify(worldLine.inject) !== JSON.stringify(['webServer', 'connection'])) {
        throw new Error('bundle plugin row does not wait for webServer and connection')
      }

      if (manifest.exports?.['./client']?.default !== './dist/client.js') {
        throw new Error(
          `unexpected client export ${JSON.stringify(manifest.exports?.['./client'])}`,
        )
      }
      if (manifest.dsh?.client?.platform !== 'web' || manifest.dsh?.client?.immediately !== true) {
        throw new Error(`unexpected dsh.client ${JSON.stringify(manifest.dsh?.client)}`)
      }
      const clientBundle = await readFile(join(root, 'dist/client.js'), 'utf8')
      if (!clientBundle.startsWith('window.__ModuleLoader__.load')) {
        throw new Error('client bundle missing ModuleLoader envelope')
      }
      if (!clientBundle.includes('id:"@seaveyon/dsh-world-line"')) {
        throw new Error('client bundle registers the wrong module id')
      }
      if (!clientBundle.includes('require("react")')) {
        throw new Error('client bundle no longer externalizes react')
      }

      return 'public export, CLI help and version, bundle patch, client envelope'
    },
  },
}

/**
 * Pack every production dependency of `manifest` that is a package of this
 * workspace, from its local build.
 *
 * The sibling's `dist/` must exist — CI builds the whole workspace before it
 * packs anything, and so must a developer running this by hand.
 *
 * @param manifest - the extracted package.json.
 * @param destination - directory the tarballs are written to.
 * @returns the tarball paths, and the names they satisfy.
 */
async function packWorkspaceSiblings(manifest, destination) {
  const packagesDir = new URL('../packages/', import.meta.url)
  const directories = new Map()
  for (const entry of await readdir(packagesDir)) {
    const manifestUrl = new URL(`${entry}/package.json`, packagesDir)
    const sibling = await readFile(manifestUrl, 'utf8').then(JSON.parse, () => undefined)
    if (sibling?.name !== undefined)
      directories.set(sibling.name, fileURLToPath(new URL(`${entry}/`, packagesDir)))
  }

  const tarballs = []
  const names = new Set()
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const directory = directories.get(name)
    if (directory === undefined) continue
    const { stdout } = await run('npm', ['pack', '--silent', '--pack-destination', destination], {
      cwd: directory,
    })
    const filename = stdout.trim().split('\n').at(-1)
    if (!filename) throw new Error(`npm pack printed no filename for ${name}`)
    tarballs.push(join(destination, filename))
    names.add(name)
  }
  return { tarballs, names }
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

  // Everything the extracted package needs at load time, installed one level
  // up — where a DSH profile's hoisted linker puts a plugin's dependencies and
  // the host's own packages sit relative to an installed plugin — and before
  // the package link below exists, because npm prunes anything in its
  // `node_modules` that nothing declares, and the link declares nothing.
  // Installing into the package root instead would make npm parse the
  // extracted manifest, whose `workspace:` devDependency specs it rejects even
  // with `--omit=dev`.
  //
  // Three kinds of thing land there: host packages the entry imports at load
  // time (see `peers` above); the package's production dependencies, fetched
  // from the registry at the range the manifest declares; and, among those, any
  // that is itself a package of this workspace — packed from the local build
  // rather than fetched, so the smoke tests the two as they are in this
  // checkout and does not depend on the registry already carrying the sibling.
  const siblings = await packWorkspaceSiblings(manifest, work)
  const fromRegistry = Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => !siblings.names.has(name))
    .map(([name, range]) => `${name}@${range}`)
  const beside = [...(entry.peers?.(manifest) ?? []), ...siblings.tarballs, ...fromRegistry]
  if (beside.length > 0) {
    await run(
      'npm',
      ['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...beside],
      { cwd: work },
    )
  }

  const dist = pathToFileURL(join(root, 'dist') + '/')

  // Resolve the package by its published name from a clean consumer location.
  // Absolute dist imports below are still useful for cold-importing every
  // module, but only this path exercises the root exports map a user receives.
  const packageLink = join(work, 'node_modules', ...manifest.name.split('/'))
  await mkdir(dirname(packageLink), { recursive: true })
  await symlink(root, packageLink, process.platform === 'win32' ? 'junction' : 'dir')
  const consumer = join(work, 'consumer.mjs')
  await writeFile(
    consumer,
    `import * as entry from ${JSON.stringify(manifest.name)}\nexport { entry }\n`,
    'utf8',
  )
  const { entry: publicEntry } = await import(pathToFileURL(consumer).href)

  // Import order is alphabetical rather than dependency-led: any module that
  // only loads because something else loaded first is a module with an
  // undeclared dependency, and importing each one cold is how that shows up.
  const modules = (await readdir(dist)).filter(
    (file) => file.endsWith('.js') && !entry.skip.includes(file),
  )
  for (const file of modules.toSorted()) await import(new URL(file, dist).href)

  const exercised = await entry.check(dist, root, publicEntry, manifest)
  console.log(`ok on ${version}: ${manifest.name}, ${modules.length} modules, ${exercised}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
