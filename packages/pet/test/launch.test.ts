/**
 * The host-side launcher: launchDesktopApp's search order against injected
 * seams, and the route handler's guards (method, custom header, loopback
 * peer) and status mapping. Requests and responses are the testkit's fakes,
 * so no socket and no Launch Services is ever touched.
 */

import { describe, expect, test } from '@rstest/core'
import { createMockContext, fakeRequest, fakeResponse } from '@seaveyon/dsh-plugin-testkit'
import { apply, inject } from '../src/index.js'
import {
  bundledDesktopBinary,
  createLaunchHandler,
  DESKTOP_BUNDLE_ID,
  LAUNCH_ROUTE_PATH,
  launchCandidates,
  launchDesktopApp,
} from '../src/launch.js'

interface RunCall {
  command: string
  args: string[]
}

/** A run stub that records calls and resolves or rejects per queue. */
function runStub(outcomes: ('ok' | 'fail')[] = ['ok']) {
  const calls: RunCall[] = []
  const run = (command: string, args: string[]) => {
    calls.push({ command, args })
    const outcome = outcomes.length > 1 ? outcomes.shift() : outcomes[0]
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('exit 1'))
  }
  return { calls, run }
}

const LOOPBACK = '127.0.0.1'

describe('launchDesktopApp', () => {
  test('a non-mac host is unsupported without touching anything', async () => {
    const { calls, run } = runStub()
    const outcome = await launchDesktopApp({ platform: 'linux', run })
    expect(outcome).toBe('unsupported-platform')
    expect(calls).toHaveLength(0)
  })

  test('the bundled binary wins over every installed copy', async () => {
    const { calls, run } = runStub(['ok'])
    const spawned: string[] = []
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      exists: () => true,
      bundledBinary: '/pkg/desktop/dsh-pet-desktop',
      spawnDetached: (path) => {
        spawned.push(path)
        return Promise.resolve()
      },
    })
    expect(outcome).toBe('launched')
    expect(spawned).toEqual(['/pkg/desktop/dsh-pet-desktop'])
    // Launch Services is never consulted: the bundled copy is version-locked.
    expect(calls).toHaveLength(0)
  })

  test('a missing bundled binary falls through to the bundle-id search', async () => {
    const { calls, run } = runStub(['ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      exists: () => false,
      bundledBinary: '/pkg/desktop/dsh-pet-desktop',
    })
    expect(outcome).toBe('launched')
    expect(calls).toEqual([{ command: 'open', args: ['-b', DESKTOP_BUNDLE_ID] }])
  })

  test('a bundled binary that refuses to spawn is launch-failed, not not-installed', async () => {
    const { calls, run } = runStub(['ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      exists: () => true,
      bundledBinary: '/pkg/desktop/dsh-pet-desktop',
      spawnDetached: () => Promise.reject(new Error('spawn ENOENT')),
    })
    expect(outcome).toBe('launch-failed')
    expect(calls).toHaveLength(0)
  })

  test('the default bundled path follows the host architecture', async () => {
    const spawned: string[] = []
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      arch: 'x64',
      exists: () => true,
      spawnDetached: (path) => {
        spawned.push(path)
        return Promise.resolve()
      },
    })
    expect(outcome).toBe('launched')
    expect(spawned).toEqual([bundledDesktopBinary('x64')])
    expect(spawned[0]).toContain('dsh-pet-desktop-x64')
  })

  test('an architecture with no bundled build falls through to the installed copies', async () => {
    const { calls, run } = runStub(['ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      arch: 'arm64',
      run,
      // The bundled arm64 path misses (source checkout layout): the
      // Launch Services chain still gets its turn.
      exists: () => false,
    })
    expect(outcome).toBe('launched')
    expect(calls).toEqual([{ command: 'open', args: ['-b', DESKTOP_BUNDLE_ID] }])
  })

  test('the bundle id is tried first among the installed copies', async () => {
    const { calls, run } = runStub(['ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      exists: () => true,
      bundledBinary: null,
    })
    expect(outcome).toBe('launched')
    expect(calls).toEqual([{ command: 'open', args: ['-b', DESKTOP_BUNDLE_ID] }])
  })

  test('a bundle-id miss falls through to the first existing candidate path', async () => {
    const { calls, run } = runStub(['fail', 'ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      env: { DSH_PET_DESKTOP_APP: '/opt/DSH Pet.app' },
      exists: (path) => path === '/Applications/DSH Pet.app',
    })
    expect(outcome).toBe('launched')
    expect(calls[1]).toEqual({ command: 'open', args: ['/Applications/DSH Pet.app'] })
  })

  test('the env override heads the candidate list', async () => {
    const { calls, run } = runStub(['fail', 'ok'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      env: { DSH_PET_DESKTOP_APP: '/opt/DSH Pet.app' },
      exists: () => true,
      bundledBinary: null,
    })
    expect(outcome).toBe('launched')
    expect(calls[1]).toEqual({ command: 'open', args: ['/opt/DSH Pet.app'] })
  })

  test('nothing indexed and nothing on disk means not-installed', async () => {
    const { run } = runStub(['fail'])
    const outcome = await launchDesktopApp({ platform: 'darwin', run, exists: () => false })
    expect(outcome).toBe('not-installed')
  })

  test('an existing app that refuses to open is launch-failed, not not-installed', async () => {
    const { run } = runStub(['fail'])
    const outcome = await launchDesktopApp({
      platform: 'darwin',
      run,
      exists: () => true,
      bundledBinary: null,
    })
    expect(outcome).toBe('launch-failed')
  })

  test('candidates cover the two standard Applications folders after the env override', () => {
    expect(launchCandidates({ env: {}, home: '/home/u' })).toEqual([
      '/Applications/DSH Pet.app',
      '/home/u/Applications/DSH Pet.app',
    ])
  })
})

describe('host entry', () => {
  test('the row injects webServer plus the gate-readiness ordering service', () => {
    expect(inject).toContain('webServer')
    expect(inject).toContain('dshWebLoginReady')
  })

  test('apply registers the launch route and the teardown unregisters it', async () => {
    const registered: string[] = []
    const webServer = {
      register: (route: { path: string }) => {
        registered.push(route.path)
        return () => {
          registered.splice(registered.indexOf(route.path), 1)
        }
      },
    }
    const ctx = createMockContext({ webServer })
    apply(ctx)

    expect(registered).toEqual([LAUNCH_ROUTE_PATH])
    expect(ctx.teardowns.map((t) => t.label)).toEqual(['dsh-pet: launch-desktop route'])

    await ctx.dispose()
    expect(registered).toHaveLength(0)
  })

  test('a host without the webServer service loads to a no-op', () => {
    const ctx = createMockContext({})
    expect(() => apply(ctx)).not.toThrow()
    expect(ctx.teardowns).toHaveLength(0)
  })
})

describe('createLaunchHandler', () => {
  const launchedRun = () => runStub(['ok']).run

  test('non-POST is 405 with an Allow header', async () => {
    const res = fakeResponse()
    await createLaunchHandler({ platform: 'darwin', run: launchedRun(), bundledBinary: null })(
      fakeRequest({ method: 'GET' }),
      res,
    )
    expect(res.status).toBe(405)
    expect(res.headers?.['allow']).toBe('POST')
  })

  test('POST without the custom header is 400 — drive-by requests cannot preflight it', async () => {
    const res = fakeResponse()
    await createLaunchHandler({ platform: 'darwin', run: launchedRun(), bundledBinary: null })(
      fakeRequest({ method: 'POST', remoteAddress: LOOPBACK }),
      res,
    )
    expect(res.status).toBe(400)
  })

  test('a non-loopback peer is 403 even with the header', async () => {
    const res = fakeResponse()
    await createLaunchHandler({ platform: 'darwin', run: launchedRun(), bundledBinary: null })(
      fakeRequest({
        method: 'POST',
        headers: { 'x-dsh-pet-launch': '1' },
        remoteAddress: '10.0.0.8',
      }),
      res,
    )
    expect(res.status).toBe(403)
  })

  test('a loopback launch answers 200 {ok:true}', async () => {
    const res = fakeResponse()
    await createLaunchHandler({ platform: 'darwin', run: launchedRun(), bundledBinary: null })(
      fakeRequest({
        method: 'POST',
        headers: { 'x-dsh-pet-launch': '1' },
        remoteAddress: LOOPBACK,
      }),
      res,
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? '')).toEqual({ ok: true })
  })

  test('IPv6 and IPv4-mapped loopback peers pass the loopback check', async () => {
    for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
      const res = fakeResponse()
      await createLaunchHandler({ platform: 'darwin', run: launchedRun(), bundledBinary: null })(
        fakeRequest({ method: 'POST', headers: { 'x-dsh-pet-launch': '1' }, remoteAddress }),
        res,
      )
      expect(res.status).toBe(200)
    }
  })

  test('a missing install is a JSON 404 the panel can tell from a route-less host', async () => {
    const res = fakeResponse()
    await createLaunchHandler({
      platform: 'darwin',
      run: runStub(['fail']).run,
      exists: () => false,
    })(
      fakeRequest({
        method: 'POST',
        headers: { 'x-dsh-pet-launch': '1' },
        remoteAddress: LOOPBACK,
      }),
      res,
    )
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body ?? '')).toEqual({ ok: false, error: 'not_installed' })
    expect(res.headers?.['content-type']).toBe('application/json')
  })

  test('unsupported platforms and failed opens map to 501 and 500', async () => {
    const resUnsupported = fakeResponse()
    await createLaunchHandler({ platform: 'linux' })(
      fakeRequest({
        method: 'POST',
        headers: { 'x-dsh-pet-launch': '1' },
        remoteAddress: LOOPBACK,
      }),
      resUnsupported,
    )
    expect(resUnsupported.status).toBe(501)

    const resFailed = fakeResponse()
    await createLaunchHandler({
      platform: 'darwin',
      run: runStub(['fail']).run,
      exists: () => true,
      bundledBinary: null,
    })(
      fakeRequest({
        method: 'POST',
        headers: { 'x-dsh-pet-launch': '1' },
        remoteAddress: LOOPBACK,
      }),
      resFailed,
    )
    expect(resFailed.status).toBe(500)
  })
})
