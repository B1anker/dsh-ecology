import { access, writeFile } from 'node:fs/promises'
import { expect, test } from '@rstest/core'
import { destroyLab, reapExpiredLabs } from '../../src/lab/cleanup.js'
import { createLab } from '../../src/lab/create.js'
import { defaultLabId, runLabDefault } from '../../src/lab/defaults.js'
import { requireKnownHost } from '../../src/lab/gate.js'
import { labDir, labManifestPath } from '../../src/lab/layout.js'
import { writeLabManifest } from '../../src/lab/manifest.js'
import { servicePath } from '../../src/lab/service.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

test('cleanup preserves active and retained labs and removes expired failures and default references', async () => {
  const home = await makeTempHome()
  try {
    const bin = await installFakeDsh(home)
    await writeProfile(home, 'web')
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: { PATH: bin },
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const host = requireKnownHost(ctx)
    const make = async () => (await createLab(ctx, host, 'web')).manifest
    const expired = await make(),
      retained = await make(),
      active = await make(),
      corrupt = await make()
    expired.state = 'failed'
    expired.retention.expiresAt = '2000-01-01T00:00:00.000Z'
    await writeLabManifest(home, expired, new Date())
    retained.purpose = 'mirror'
    retained.state = 'failed'
    retained.retention.expiresAt = '2099-01-01T00:00:00.000Z'
    await writeLabManifest(home, retained, new Date())
    active.state = 'applying'
    await writeLabManifest(home, active, new Date())
    await writeFile(labManifestPath(home, corrupt.id), 'invalid json')
    const result = await reapExpiredLabs(home, new Date())
    expect(result.reaped).toEqual([expired.id])
    expect(result.scanned).toBe(4)
    await expect(access(labDir(home, expired.id))).rejects.toThrow()
    await access(labDir(home, retained.id))
    await expect(destroyLab(home, active.id)).rejects.toThrow('mid-run')
    await access(labDir(home, active.id))
    await runLabDefault(ctx, retained.id)
    expect(await defaultLabId(home, 'web')).toBe(retained.id)
    await writeFile(
      servicePath(home, retained.id),
      JSON.stringify({
        id: retained.id,
        state: 'running',
        controlPort: 12345,
        controlToken: 'a'.repeat(64),
      }),
    )
    await expect(destroyLab(home, retained.id)).rejects.toThrow('running')
    await writeFile(
      servicePath(home, retained.id),
      JSON.stringify({
        id: retained.id,
        state: 'stopped',
        controlPort: 12345,
        controlToken: 'a'.repeat(64),
      }),
    )
    expect((await destroyLab(home, retained.id)).removed).toBe(true)
    expect(await defaultLabId(home, 'web')).toBeUndefined()
    expect((await destroyLab(home, corrupt.id)).removed).toBe(true)
    active.state = 'destroyed'
    await writeLabManifest(home, active, new Date())
    await expect(destroyLab(home, active.id)).rejects.toThrow('already destroyed')
  } finally {
    await destroyTempHome(home)
  }
})
