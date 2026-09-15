import { afterEach, describe, expect, it } from '@rstest/core'
import {
  createMockConnection,
  createMockContext,
  createMockWebServer,
  type MockConnection,
  type MockWebServer,
} from '@seaveyon/dsh-plugin-testkit'
import { apply, inject } from '../src/index.js'

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

  it('unregisters every route on disposal', async () => {
    const { ctx, listen } = boot(createMockConnection())
    const port = await listen()
    expect(ctx.teardowns).toHaveLength(ROUTES.length)
    await ctx.dispose()
    const response = await fetch(`http://127.0.0.1:${port}${ROUTES[0]}`, { method: 'POST' })
    expect(response.status).toBe(404)
  })
})
