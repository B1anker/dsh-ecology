import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import { type LabManifest, writeLabManifest } from '../../src/lab/manifest.js'
import { apply, operate, worldLines } from '../../src/web/index.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

describe('world-line Web boundary', () => {
  test('native authentication precedes reads and mutations; writes require same-origin JSON', async () => {
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    let disposed = false
    const cleanups: Array<() => void> = []
    apply({
      get: <T>(name: string) =>
        (name === 'webServer'
          ? {
              register: (route: { handler: typeof handler }) => {
                handler = route.handler
                return () => {
                  disposed = true
                }
              },
            }
          : {
              requestRejection: (req: IncomingMessage) =>
                req.headers.cookie === 'fixture=valid' ? undefined : 401,
            }) as T,
      effect: (setup) => {
        cleanups.push(setup())
      },
    })
    const server = createServer((req, res) => void handler!(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}`
    try {
      expect((await fetch(url)).status).toBe(401)
      expect((await fetch(url, { method: 'POST', body: '{"action":"create"}' })).status).toBe(401)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: {
              cookie: 'fixture=valid',
              origin: 'https://evil.example',
              'content-type': 'application/json',
            },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { cookie: 'fixture=valid', 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { cookie: 'fixture=valid', origin: url, 'content-type': 'text/plain' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cleanups.forEach((fn) => fn())
    }
    expect(disposed).toBe(true)
  })
  test('lists lineage without secrets, rejects cross-profile and self-stop, preserves identity on rename/default', async () => {
    const home = await makeTempHome()
    const ctx: CliContext = {
      home,
      cwd: home,
      env: {},
      profileName: 'web',
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const id = 'lab-20260906T120000Z-11111111'
    const other = 'lab-20260906T120000Z-22222222'
    const manifest: LabManifest = {
      manifestVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      adapterId: 'test',
      dshVersion: 'test',
      runtime: { nodeVersion: 'test', os: 'test', arch: 'test' },
      source: { profileName: 'web', receipt: 'secret-receipt', parentLabId: other },
      purpose: 'mirror',
      state: 'passed',
      runCount: 0,
      plan: [],
      retention: { cleanupMode: 'keep-on-failure' },
    }
    try {
      await writeLabManifest(home, manifest, new Date())
      await writeLabManifest(
        home,
        { ...manifest, id: other, source: { profileName: 'headless', receipt: 'secret' } },
        new Date(),
      )
      const listed = await worldLines(ctx, id)
      expect(listed.lines.length).toBe(1)
      expect(listed.lines[0]?.parentId).toBe(other)
      expect(JSON.stringify(listed)).not.toContain('secret')
      expect(listed.lines[0]?.verdict).toBe(null)
      await expect(operate(ctx, { action: 'stop', id }, id)).rejects.toThrow('另一实例')
      await expect(operate(ctx, { action: 'destroy', id }, id)).rejects.toThrow('另一实例')
      await expect(operate(ctx, { action: 'start', id: other })).rejects.toThrow('profile')
      await expect(
        operate(ctx, { action: 'create', from: other, alias: 'cross-profile' }),
      ).rejects.toThrow('profile')
      await operate(ctx, { action: 'alias', id, alias: 'my-world' })
      await operate(ctx, { action: 'default', id: 'my-world' })
      expect((await worldLines(ctx)).lines[0]).toMatchObject({
        id,
        alias: 'my-world',
        isDefault: true,
      })
    } finally {
      await destroyTempHome(home)
    }
  })
})
