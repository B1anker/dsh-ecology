import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { runSnapshotCreate } from '../../src/commands/snapshot.js'
import type { CliContext } from '../../src/context.js'
import { createLab } from '../../src/lab/create.js'
import type { KnownHost } from '../../src/lab/gate.js'
import { inheritHome } from '../../src/lab/home-inheritance.js'
import { labHomeDir, listLabs } from '../../src/lab/layout.js'
import { writeLabManifest } from '../../src/lab/manifest.js'
import { snapshotSource } from '../../src/lab/snapshot-source.js'
import { operate, worldLines } from '../../src/web/index.js'
import { compareWorlds, snapshotDetail, snapshotEvents } from '../../src/web/insights.js'
import {
  destroyTempHome,
  makeTempHome,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const context = (home: string): CliContext => ({
  home,
  cwd: home,
  profileName: 'web',
  env: { WORLD_LINE_DISABLE_KEYCHAIN: '1', PATH: '' },
  json: true,
  breakStaleLock: false,
  now: () => new Date(),
})
const host = { adapterId: 'fixture', raw: '0.1.2-rc.1' } as KnownHost
async function child(ctx: CliContext, profile = 'web') {
  await writeProfile(ctx.home, profile)
  const created = await createLab(ctx, host, profile)
  await writeLabManifest(ctx.home, { ...created.manifest, purpose: 'mirror' }, ctx.now())
  return created.manifest.id
}
describe('world-line checkpoints and comparisons', () => {
  test('compares live worlds without creating snapshots or exposing raw secrets and paths', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    try {
      const id = await child(ctx)
      const childHome = labHomeDir(home, id)
      await writeProfile(home, 'web', {
        packageJson: profilePackageJson({ dependencies: { demo: '1.0.0' } }),
        patchYaml: '- id: demo\n  config:\n    password: super-secret-before\n    enabled: true\n',
      })
      await writeProfile(childHome, 'web', {
        packageJson: profilePackageJson({ dependencies: { demo: '2.0.0' } }),
        patchYaml: '- id: demo\n  config:\n    password: super-secret-after\n    enabled: false\n',
      })
      const diff = await compareWorlds(ctx, 'origin', id)
      expect(diff.dependencies).toContainEqual({
        name: 'demo',
        before: '1.0.0',
        after: '2.0.0',
        status: 'changed',
        changes: ['依赖声明'],
      })
      expect(diff.patches.length).toBe(1)
      expect(JSON.stringify(diff)).not.toContain('super-secret')
      expect(JSON.stringify(diff)).not.toContain(home)
      expect(await snapshotEvents(ctx, 'origin')).toEqual([])
      const other = await child(ctx, 'headless')
      await expect(compareWorlds(ctx, 'origin', other)).rejects.toThrow('profile')
      await expect(compareWorlds(ctx, 'origin', '../../etc')).rejects.toThrow()
      await expect(compareWorlds(ctx, id, id)).rejects.toThrow('不同')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('snapshot events stay on their owning world; details and writes reject cross-profile access', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    try {
      const id = await child(ctx),
        own = { ...ctx, home: labHomeDir(home, id) }
      const saved = (await operate(ctx, { action: 'snapshot', id, label: '升级之前' })) as {
        snapshotId: string
      }
      const listed = await worldLines(ctx)
      expect(listed.events.find((event) => event.snapshotId === saved.snapshotId)).toMatchObject({
        lineId: id,
        kind: 'snapshot',
        title: '升级之前',
        restorable: true,
      })
      expect((await snapshotDetail(own, saved.snapshotId)).restorable).toBe(true)
      await expect(
        operate(ctx, { action: 'snapshot-detail', id: 'origin', snapshotId: saved.snapshotId }),
      ).rejects.toThrow()
      const other = await child(ctx, 'headless')
      await expect(operate(ctx, { action: 'snapshot', id: other, label: 'no' })).rejects.toThrow(
        'profile',
      )
      await expect(operate(ctx, { action: 'snapshot', id, label: 'x\ny' })).rejects.toThrow(
        'control',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
  test('branches from the source vault using historical profile and home patches, without resurrecting absent files', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    try {
      const id = await child(ctx),
        sourceHome = labHomeDir(home, id),
        own = { ...ctx, home: sourceHome }
      await writeFile(join(sourceHome, 'cordis.patch.yml'), '- id: old-home\n')
      const snapshot = await runSnapshotCreate(own, { label: 'before' })
      await writeFile(join(sourceHome, 'cordis.patch.yml'), '- id: new-home\n')
      await writeFile(join(sourceHome, 'profiles/web/cordis.patch.yml'), '- id: new-profile\n')
      await writeFile(join(sourceHome, 'profiles/web/pnpm-lock.yaml'), 'new lock')
      await mkdir(join(sourceHome, 'sessions'), { recursive: true })
      await writeFile(join(sourceHome, 'sessions/history.txt'), 'current conversation')
      const source = await snapshotSource(own, snapshot.id)
      const branch = await createLab(ctx, host, 'web', { sourceHome, parentLabId: id, source })
      const targetHome = labHomeDir(home, branch.manifest.id)
      await inheritHome(sourceHome, targetHome, { skipPaths: ['profiles/web', 'cordis.patch.yml'] })
      expect(branch.manifest.source).toMatchObject({
        parentLabId: id,
        snapshotId: snapshot.id,
        kind: 'restore',
      })
      expect(await readFile(join(targetHome, 'cordis.patch.yml'), 'utf8')).toBe('- id: old-home\n')
      expect(await readFile(join(targetHome, 'profiles/web/cordis.patch.yml'), 'utf8')).toContain(
        'fixture-entry',
      )
      await expect(readFile(join(targetHome, 'profiles/web/pnpm-lock.yaml'))).rejects.toThrow()
      expect(await readFile(join(targetHome, 'sessions/history.txt'), 'utf8')).toBe(
        'current conversation',
      )
      expect(await readFile(join(sourceHome, 'cordis.patch.yml'), 'utf8')).toBe('- id: new-home\n')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('missing secret bytes refuse before a lab is allocated', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    try {
      await writeProfile(home, 'web', {
        patchYaml: '- id: demo\n  config:\n    apiKey: sk-sensitive-not-saved\n',
      })
      const saved = await runSnapshotCreate(ctx, { label: 'skipped' })
      expect((await snapshotDetail(ctx, saved.id)).restorable).toBe(false)
      const source = await snapshotSource(ctx, saved.id)
      await expect(createLab(ctx, host, 'web', { source })).rejects.toThrow('no stored bytes')
      expect(await listLabs(home)).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })
  test('a code-only local plugin edit invalidates snapshot branching', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    try {
      const plugin = join(home, 'plugin')
      await mkdir(plugin)
      await writeFile(join(plugin, 'package.json'), '{"name":"demo","version":"1.0.0"}')
      await writeFile(join(plugin, 'index.js'), 'export const a=1')
      await writeProfile(home, 'web', {
        packageJson: profilePackageJson({ dependencies: { demo: `file:${plugin}` } }),
      })
      const saved = await runSnapshotCreate(ctx, { label: 'local source' })
      expect((await snapshotDetail(ctx, saved.id)).restorable).toBe(true)
      await snapshotSource(ctx, saved.id)
      await writeFile(join(plugin, 'index.js'), 'export const a=2')
      await expect(snapshotSource(ctx, saved.id)).rejects.toThrow('源码已变化')
      expect(await listLabs(home)).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })
  test('encrypted profile and home patches restore together without exposing their values in details', async () => {
    const home = await makeTempHome(),
      ctx = context(home)
    ctx.env.WORLD_LINE_SECRET_KEY = '1'.repeat(64)
    try {
      await writeProfile(home, 'web', {
        patchYaml: '- id: demo\n  config:\n    apiKey: sk-fixture-encrypted-profile\n',
      })
      await writeFile(
        join(home, 'cordis.patch.yml'),
        '- id: auth\n  config:\n    password: fixture-home-password\n',
      )
      const saved = await runSnapshotCreate(ctx, { label: 'encrypted checkpoint' })
      const detail = await snapshotDetail(ctx, saved.id)
      expect(detail.restorable).toBe(true)
      expect(JSON.stringify(detail)).not.toContain('fixture-home-password')
      expect(JSON.stringify(detail)).not.toContain('sk-fixture')
      const source = await snapshotSource(ctx, saved.id)
      const branch = await createLab(ctx, host, 'web', { source })
      const target = labHomeDir(home, branch.manifest.id)
      expect(await readFile(join(target, 'cordis.patch.yml'), 'utf8')).toContain(
        'fixture-home-password',
      )
      expect(await readFile(join(target, 'profiles/web/cordis.patch.yml'), 'utf8')).toContain(
        'sk-fixture-encrypted-profile',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
})
