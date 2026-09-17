/**
 * The host plugin's service graph: what `createServices` declares, how the
 * location is read from the environment, and what a test can swap without
 * running `apply` — the route over a fake context factory, most usefully.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { InstantiationService, SyncDescriptor } from '@seaveyon/dsh-di'
import type { CliContext } from '../../src/context.js'
import {
  API_PATH,
  apply,
  createServices,
  IConnection,
  IContextFactory,
  ILocation,
  IManagementApi,
  IOperateDeps,
  IPluginContext,
  IReadCache,
  IWebServer,
  locate,
  ManagementApi,
  readCache,
  type WebContext,
} from '../../src/web/index.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

type Route = {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** A host context over a recording registry and a cookie-checking connection. */
function host(options: { connection?: unknown } = {}) {
  const routes: Route[] = []
  const effects: { label: string | undefined; dispose: () => void }[] = []
  const webServer = {
    register: (route: Route) => {
      routes.push(route)
      return () => {
        routes.splice(routes.indexOf(route), 1)
      }
    },
  }
  const connection =
    'connection' in options
      ? options.connection
      : {
          requestRejection: (req: IncomingMessage) =>
            req.headers.cookie === 'fixture=valid' ? undefined : 401,
        }
  const ctx: WebContext = {
    get: <T>(name: string) =>
      (name === 'webServer' ? webServer : name === 'connection' ? connection : undefined) as T,
    effect: (setup, label) => {
      effects.push({ label, dispose: setup() })
    },
  }
  return { ctx, webServer, connection, routes, effects }
}

describe('locate', () => {
  test('reads the runtime home, the current lab and the manager home from the environment', () => {
    const manager = '/tmp/wl-manager'
    const id = 'lab-20260906T120000Z-11111111'
    const asManager = locate({ DSH_HOME: manager }, 'web')
    expect(asManager).toEqual({
      runtimeHome: manager,
      currentId: undefined,
      home: manager,
      profileName: 'web',
    })
    const asLab = locate(
      {
        DSH_HOME: join(manager, 'world-line', 'labs', id, 'home'),
        WORLD_LINE_LAB: id,
        WORLD_LINE_MANAGER_HOME: manager,
      },
      'headless',
    )
    expect(asLab.currentId).toBe(id)
    expect(asLab.home).toBe(manager)
    expect(asLab.profileName).toBe('headless')
  })

  test('falls back to ~/.dsh when DSH_HOME is unset', () => {
    expect(locate({}, 'web', '/home/x/.dsh').runtimeHome).toBe('/home/x/.dsh')
  })
})

describe('createServices', () => {
  test('declares both host services, the location, the shared cache and the two recipes', () => {
    const { ctx, webServer, connection } = host()
    const collection = createServices(ctx, { profile: 'web' }, { DSH_HOME: '/tmp/wl' })
    expect(collection.get(IWebServer)).toBe(webServer)
    expect(collection.get(IConnection)).toBe(connection)
    expect(collection.get(IPluginContext)).toBe(ctx)
    expect(collection.get(ILocation)).toMatchObject({ home: '/tmp/wl', profileName: 'web' })
    expect(collection.get(IReadCache)).toBe(readCache)
    expect(collection.get(IOperateDeps)).toEqual({})
    expect(collection.get(IContextFactory)).toBeInstanceOf(SyncDescriptor)
    expect(collection.get(IManagementApi)).toBeInstanceOf(SyncDescriptor)
  })

  test('refuses a host without browser authentication before anything is registered', () => {
    expect(() => createServices(host({ connection: undefined }).ctx)).toThrow(
      'World Line requires DSH browser authentication',
    )
    expect(() => createServices(host({ connection: {} }).ctx)).toThrow(
      'World Line requires DSH browser authentication',
    )
  })

  test('the context factory reads the manager home and the profile from the location', async () => {
    const home = await makeTempHome()
    try {
      const services = new InstantiationService(
        createServices(host().ctx, { profile: 'headless' }, { DSH_HOME: home }),
      )
      const ctx = await services.get(IContextFactory).create()
      expect(ctx.home).toBe(home)
      expect(ctx.cwd).toBe(home)
      expect(ctx.profileName).toBe('headless')
      expect(ctx.json).toBe(true)
      expect(ctx.breakStaleLock).toBe(false)
      services.dispose()
    } finally {
      await destroyTempHome(home)
    }
  })

  test('the API resolves over a context-factory double and still authenticates every request', async () => {
    const home = await makeTempHome()
    const fixture = host()
    const collection = createServices(fixture.ctx, {}, { DSH_HOME: home })
    let created = 0
    collection.set(IContextFactory, {
      _serviceBrand: undefined,
      create: (): Promise<CliContext> => {
        created += 1
        return Promise.resolve({
          home,
          cwd: home,
          env: {},
          profileName: 'web',
          json: true,
          breakStaleLock: false,
          now: () => new Date(),
        })
      },
    })
    const services = new InstantiationService(collection)
    const api = services.get(IManagementApi)
    expect(api).toBeInstanceOf(ManagementApi)
    expect(api.path).toBe(API_PATH)

    const dispose = api.register()
    expect(fixture.routes.map((route) => [route.kind, route.path])).toEqual([['exact', API_PATH]])
    const server = createServer((req, res) => void fixture.routes[0]!.handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      // Unauthenticated: refused before the context is ever built.
      expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(401)
      expect(created).toBe(0)
      // Authenticated read: goes through the double, lists the empty home.
      const listed = await fetch(`http://127.0.0.1:${port}`, {
        headers: { cookie: 'fixture=valid' },
      })
      expect(listed.status).toBe(200)
      expect(created).toBe(1)
      expect(await listed.json()).toMatchObject({ lines: [] })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      dispose()
      expect(fixture.routes).toEqual([])
      services.dispose()
      await destroyTempHome(home)
    }
  })
})

describe('apply', () => {
  test('mounts the container first, then the watcher, the timers and the route', async () => {
    const home = await makeTempHome()
    const prior = { DSH_HOME: process.env.DSH_HOME, WORLD_LINE_LAB: process.env.WORLD_LINE_LAB }
    process.env.DSH_HOME = home
    delete process.env.WORLD_LINE_LAB
    const fixture = host()
    try {
      apply(fixture.ctx)
      expect(fixture.effects.map((effect) => effect.label)).toEqual([
        'world-line: service container',
        'world-line: metadata invalidation',
        'world-line: result window ownership',
        'world-line: upgrade scheduler',
        'world-line: authenticated management API',
      ])
      expect(fixture.routes.map((route) => route.path)).toEqual([API_PATH])
    } finally {
      for (const effect of fixture.effects.toReversed()) effect.dispose()
      expect(fixture.routes).toEqual([])
      if (prior.DSH_HOME === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prior.DSH_HOME
      if (prior.WORLD_LINE_LAB !== undefined) process.env.WORLD_LINE_LAB = prior.WORLD_LINE_LAB
      await destroyTempHome(home)
    }
  })
})
