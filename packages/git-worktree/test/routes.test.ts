import { afterEach, describe, expect, it } from '@rstest/core'
import { InstantiationService, SyncDescriptor } from '@seaveyon/dsh-di'
import {
  createMockConnection,
  createMockContext,
  createMockServices,
  createMockWebServer,
  type MockConnection,
  type MockWebServer,
} from '@seaveyon/dsh-plugin-testkit'
import { WorktreeApi } from '../src/api.js'
import {
  apply,
  createServices,
  IConnection,
  IPluginContext,
  ITools,
  IWebServer,
  IWorktreeApi,
  IWorktreeTools,
  inject,
} from '../src/index.js'

/**
 * The management API runs Git against a caller-supplied path, so every route
 * must sit behind the host's connection fence. These tests drive the real
 * `apply` over the testkit's registry and connection doubles, through a real
 * socket, and check that a rejected request never reaches a handler.
 */

const ROUTES = [
  'branches',
  'create-conflict',
  'create',
  'remove',
  'workspace-groups',
  'reveal',
].map((name) => `/api/plugins/dsh-git-worktree/${name}`)

let web: MockWebServer | undefined

afterEach(async () => {
  await web?.close()
  web = undefined
})

function boot(connection: MockConnection) {
  web = createMockWebServer()
  const ctx = createMockContext({ webServer: web.service, connection })
  const registered: string[] = []
  apply(
    Object.assign(ctx, {
      tools: {
        register(tool: { name: string }) {
          registered.push(tool.name)
        },
      },
    }),
  )
  return { ctx, registered, listen: () => web!.listen() }
}

describe('management API fence', () => {
  it('injects the connection service so the loader gates on it', () => {
    expect(inject).toContain('connection')
    expect(inject).toContain('webServer')
    expect(inject).toContain('tools')
  })

  it('refuses to start without a connection service to consult', () => {
    web = createMockWebServer()
    const ctx = Object.assign(createMockContext({ webServer: web.service }), {
      tools: { register() {} },
    })
    expect(() => apply(ctx)).toThrow(/connection service missing/)
    expect(ctx.teardowns).toHaveLength(0)
  })

  it('answers with the fence status and never runs the handler when rejected', async () => {
    const connection = createMockConnection(() => 401)
    const { listen } = boot(connection)
    const port = await listen()

    for (const path of ROUTES) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/nonexistent', path: '/nonexistent', paths: [] }),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
    // Every route consulted the fence exactly once.
    expect(connection.consulted).toHaveLength(ROUTES.length)
    // `reveal` on GET is a harmless capability probe, and it is fenced too.
    const probe = await fetch(`http://127.0.0.1:${port}${ROUTES[5]}`)
    expect(probe.status).toBe(401)
  })

  it('maps a 403 from the fence to a forbidden body', async () => {
    const connection = createMockConnection(() => 403)
    const { listen } = boot(connection)
    const port = await listen()
    const response = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden' })
  })

  it('lets an accepted request through to the route validation', async () => {
    const connection = createMockConnection()
    const { listen, registered } = boot(connection)
    const port = await listen()

    // Accepted, so the handler runs and applies its own input validation.
    const branches = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(branches.status).toBe(400)
    expect(await branches.json()).toEqual({ error: 'cwd_required' })

    const wrongMethod = await fetch(`http://127.0.0.1:${port}${ROUTES[2]}`)
    expect(wrongMethod.status).toBe(405)

    expect(connection.consulted.map((entry) => entry.rejection)).toEqual([undefined, undefined])
    expect(registered).toEqual(['worktree_list', 'worktree_create', 'worktree_remove'])
  })

  it('unregisters every route on disposal, then the container', async () => {
    const { ctx, listen } = boot(createMockConnection())
    const port = await listen()
    // One teardown per route, each labelled for the host, plus the container's.
    expect(ctx.teardowns).toHaveLength(ROUTES.length + 1)
    expect(ctx.teardowns[0]?.label).toBe('dsh-git-worktree: service container')
    expect(ctx.teardowns.slice(1).map((entry) => entry.label)).toEqual([
      'dsh-git-worktree: branches endpoint',
      'dsh-git-worktree: create conflict endpoint',
      'dsh-git-worktree: create endpoint',
      'dsh-git-worktree: remove endpoint',
      'dsh-git-worktree: workspace groups endpoint',
      'dsh-git-worktree: reveal endpoint',
    ])
    await ctx.dispose()
    const response = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, { method: 'POST' })
    expect(response.status).toBe(404)
  })
})

describe('service graph', () => {
  it('declares the host services and the two the plugin builds', () => {
    web = createMockWebServer()
    const connection = createMockConnection()
    const tools = { register() {} }
    const ctx = Object.assign(createMockContext({ webServer: web.service, connection }), { tools })
    const collection = createServices(ctx)

    expect(collection.get(IWebServer)).toBe(web.service)
    expect(collection.get(IConnection)).toBe(connection)
    expect(collection.get(ITools)).toBe(tools)
    expect(collection.get(IPluginContext)).toBe(ctx)
    expect(collection.get(IWorktreeApi)).toBeInstanceOf(SyncDescriptor)
    expect(collection.get(IWorktreeTools)).toBeInstanceOf(SyncDescriptor)
    expect(String(IWorktreeApi)).toBe('worktreeApi')
    expect(String(IWorktreeTools)).toBe('worktreeTools')
  })

  it('resolves the API against the testkit doubles, fenced, without apply', async () => {
    const mock = createMockServices({ connection: createMockConnection(() => 403) })
    web = mock.web
    try {
      const api = mock.services.createInstance(WorktreeApi)
      expect(api.routes.map((route) => route.path)).toEqual(ROUTES)
      const dispose = api.register(api.routes[0]!)
      const port = await mock.web.listen()
      const rejected = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, { method: 'POST' })
      expect(rejected.status).toBe(403)
      dispose()
      const gone = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, { method: 'POST' })
      expect(gone.status).toBe(404)
    } finally {
      await mock.dispose()
      web = undefined
    }
  })

  it('lets a test swap the API for a double while keeping the rest of the graph', () => {
    web = createMockWebServer()
    const registered: string[] = []
    const ctx = Object.assign(
      createMockContext({ webServer: web.service, connection: createMockConnection() }),
      {
        tools: {
          register(tool: { name: string }) {
            registered.push(tool.name)
          },
        },
      },
    )
    const collection = createServices(ctx).clone()
    const fake: IWorktreeApi = { _serviceBrand: undefined, routes: [], register: () => () => {} }
    collection.set(IWorktreeApi, fake)
    const services = new InstantiationService(collection)

    expect(services.get(IWorktreeApi)).toBe(fake)
    const tools = services.get(IWorktreeTools)
    expect(tools.names).toEqual(['worktree_list', 'worktree_create', 'worktree_remove'])
    tools.register()
    expect(registered).toEqual(tools.names)
    services.dispose()
  })
})
