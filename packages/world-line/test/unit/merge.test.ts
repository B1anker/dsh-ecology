import { chmod, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import type { CliContext } from '../../src/context.js'
import {
  CLIENT_BOOT_GLOBALS,
  CLIENT_SHELL_MARKERS,
  CLIENT_SHELL_STATES,
} from '../../src/host-adapters/dsh-client-0.1.x.js'
import { createLab } from '../../src/lab/create.js'
import { requireKnownHost } from '../../src/lab/gate.js'
import { inheritHome } from '../../src/lab/home-inheritance.js'
import { labHomeDir, labProfileDir } from '../../src/lab/layout.js'
import { currentLabId, managerHome } from '../../src/lab/manager.js'
import { writeLabManifest } from '../../src/lab/manifest.js'
import type { LabRunDeps } from '../../src/lab/run.js'
import type { runCaptured } from '../../src/lab/runner.js'
import {
  commitMerge,
  mergePackage,
  mergePreview,
  portablePnpmMetadata,
  prepareMerge,
  prepareRuntimeLinks,
} from '../../src/web/merge.js'
import {
  destroyTempHome,
  installFakeDsh,
  makeTempHome,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const outcome = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  spawnError: null,
  stdout: '[]\n',
  stderr: '',
} as const
const runtime: Partial<LabRunDeps> = {
  capture: async () => outcome,
  launch: async () => ({
    kind: 'ready',
    detail: 'ready',
    handle: {
      pid: 12345,
      url: 'http://127.0.0.1:5555/',
      port: 5555,
      stop: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    },
  }),
  httpGet: async () => ({ status: 200 }),
  browserLaunch: async () => ({
    close: async () => {},
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
        waitForTimeout: async () => {},
        on: () => {},
        evaluate: async <T>() =>
          ({
            mountChildren: 1,
            buttons: ['新会话', '设置'],
            roles: ['tree'],
            bodyHas: ['暂无会话', '工作区', ...CLIENT_SHELL_MARKERS, CLIENT_SHELL_STATES[0]],
            bootGlobals: [...CLIENT_BOOT_GLOBALS],
            bootEntries: 2,
          }) as T,
      }),
    }),
  }),
}
const install: typeof runCaptured = async (_binary, _args, options) => {
  await mkdir(join(options.cwd, 'node_modules'), { recursive: true })
  await writeFile(join(options.cwd, 'node_modules', 'installed.txt'), 'verified-code')
  return outcome
}
async function seed() {
  const home = await makeTempHome(),
    bin = await installFakeDsh(home)
  await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n')
  await chmod(join(bin, 'pnpm'), 0o755)
  const ctx: CliContext = {
    home,
    cwd: home,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORLD_LINE_DISABLE_KEYCHAIN: '1',
      WORLD_LINE_SECRET_KEY: 'a'.repeat(64),
    },
    profileName: 'web',
    json: true,
    breakStaleLock: false,
    now: () => new Date(),
  }
  await writeProfile(home, 'web', {
    packageJson: profilePackageJson({ dependencies: {}, bundles: [] }),
    patchYaml: '- id: test\n  config:\n    value: main\n',
  })
  await mkdir(join(home, 'profiles/web/node_modules'))
  await writeFile(join(home, 'profiles/web/node_modules/old.txt'), 'old-code')
  const source = await createLab(ctx, requireKnownHost(ctx), 'web')
  await writeLabManifest(
    home,
    { ...source.manifest, purpose: 'mirror', alias: 'feature' },
    ctx.now(),
  )
  const local = join(home, 'source-plugin')
  await mkdir(local)
  await writeFile(
    join(local, 'package.json'),
    JSON.stringify({ name: '@fixture/new', version: '1.0.0' }),
  )
  await writeFile(join(local, 'index.js'), 'new-code')
  await writeProfile(labHomeDir(home, source.manifest.id), 'web', {
    packageJson: profilePackageJson({
      dependencies: { '@fixture/new': `file:${local}` },
      bundles: ['@fixture/new'],
    }),
    patchYaml: '- id: test\n  config:\n    value: branch\n',
  })
  return { ctx, id: source.manifest.id, home, local }
}
describe('verified world-line merges', () => {
  test('pnpm metadata keeps immutable artifact paths after moving the runtime', () => {
    const output = portablePnpmMetadata(
      `importers:
  .:
    dependencies:
      plugin:
        version: file:../artifacts/plugin
packages:
  plugin@file:../artifacts/plugin:
    resolution:
      directory: ../artifacts/plugin
      type: directory
`,
      '/candidate/profile',
      ['/candidate/artifacts/plugin'],
    )
    expect(output).toContain('version: file:/candidate/artifacts/plugin')
    expect(output).toContain('plugin@file:/candidate/artifacts/plugin:')
    expect(output).toContain('directory: /candidate/artifacts/plugin')
    expect(output).not.toContain('../artifacts')
  })
  test('runtime links survive relocation and external mutable links are rejected', async () => {
    const home = await makeTempHome()
    try {
      const modules = join(home, 'candidate/node_modules')
      const artifacts = join(home, 'artifacts')
      await mkdir(modules, { recursive: true })
      await mkdir(artifacts)
      await writeFile(join(modules, 'code.js'), 'verified')
      await symlink(join(modules, 'code.js'), join(modules, 'entry.js'))
      await prepareRuntimeLinks(modules, artifacts)
      expect(await readlink(join(modules, 'entry.js'))).toBe('code.js')
      await rename(modules, join(home, 'node_modules'))
      expect(await readFile(join(home, 'node_modules/entry.js'), 'utf8')).toBe('verified')
      await writeFile(join(home, 'outside.js'), 'mutable')
      await symlink(join(home, 'outside.js'), join(home, 'node_modules/escape.js'))
      await expect(prepareRuntimeLinks(join(home, 'node_modules'), artifacts)).rejects.toThrow(
        '验证范围外',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
  test('selected dependencies and bundles change; unrelated main settings survive', () => {
    const target = {
      dependencies: { keep: '1', change: '1' },
      scripts: { mine: 'yes' },
      dsh: { profile: { bundles: ['keep', 'change'], patchReload: 'off' } },
    }
    const source = {
      dependencies: { change: '2', extra: '3' },
      dsh: { profile: { bundles: ['change', 'extra'] } },
    }
    expect(mergePackage(target, source, ['change'])).toEqual({
      ...target,
      dependencies: { keep: '1', change: '2' },
    })
    expect(mergePackage(target, source, ['keep']).dependencies).toEqual({ change: '1' })
    expect(target.dependencies.change).toBe('1')
  })
  test('prepare isolates and verifies; commit preserves home data, backs up and is idempotent', async () => {
    const { ctx, id, home } = await seed()
    try {
      await writeFile(join(home, 'settings.yaml'), 'models: {}\n')
      const preview = await mergePreview(ctx, id)
      expect(JSON.stringify(preview)).not.toContain(home)
      const ready = await prepareMerge(
        ctx,
        { id, revision: preview.revision, plugins: ['@fixture/new'], includeConfig: false },
        { install, run: runtime },
      )
      expect(ready.ok).toBe(true)
      expect(await readFile(join(home, 'profiles/web/node_modules/old.txt'), 'utf8')).toBe(
        'old-code',
      )
      const committed = await commitMerge(ctx, ready.id)
      expect(committed.committed).toBe(true)
      expect(committed.preSnapshot).toMatch(/^snap-/)
      expect(await readFile(join(home, 'profiles/web/node_modules/installed.txt'), 'utf8')).toBe(
        'verified-code',
      )
      expect(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')).toContain(
        'value: main',
      )
      expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe('models: {}\n')
      const pkg = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
      expect(pkg.dependencies['@fixture/new']).toContain('/world-line/merges/')
      expect(pkg.dependencies['@fixture/new']).not.toContain('/labs/')
      expect((await commitMerge(ctx, ready.id)).committed).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })
  test('stale preview and post-verification main drift both fail without changing dependencies', async () => {
    const { ctx, id, home } = await seed()
    try {
      const preview = await mergePreview(ctx, id)
      await expect(
        prepareMerge(
          ctx,
          { id, revision: 'stale', plugins: ['@fixture/new'], includeConfig: false },
          { install, run: runtime },
        ),
      ).rejects.toThrow('重新预览')
      const ready = await prepareMerge(
        ctx,
        { id, revision: preview.revision, plugins: ['@fixture/new'], includeConfig: false },
        { install, run: runtime },
      )
      await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: changed\n')
      await expect(commitMerge(ctx, ready.id)).rejects.toThrow('验证后变化')
      expect(await readFile(join(home, 'profiles/web/node_modules/old.txt'), 'utf8')).toBe(
        'old-code',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
  test('mutated candidate runtime is never committed', async () => {
    const { ctx, id, home } = await seed()
    try {
      const preview = await mergePreview(ctx, id)
      const ready = await prepareMerge(
        ctx,
        { id, revision: preview.revision, plugins: ['@fixture/new'], includeConfig: true },
        { install, run: runtime },
      )
      const record = JSON.parse(
        await readFile(join(home, 'world-line/merges', ready.id, 'candidate.json'), 'utf8'),
      )
      await writeFile(
        join(labProfileDir(home, record.labId, 'web'), 'node_modules/installed.txt'),
        'tampered',
      )
      await expect(commitMerge(ctx, ready.id)).rejects.toThrow('候选已变化')
      expect(await readFile(join(home, 'profiles/web/node_modules/old.txt'), 'utf8')).toBe(
        'old-code',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
  test('failed browser gate refuses commit, even after a successful boot', async () => {
    const { ctx, id, home } = await seed()
    try {
      const preview = await mergePreview(ctx, id)
      const ready = await prepareMerge(
        ctx,
        { id, revision: preview.revision, plugins: ['@fixture/new'], includeConfig: false },
        { install, run: { ...runtime, browserLaunch: async () => null } },
      )
      expect(ready.ok).toBe(false)
      await expect(commitMerge(ctx, ready.id)).rejects.toThrow('验证未通过')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('failed file swap restores the previous dependency tree', async () => {
    const { ctx, id, home } = await seed()
    try {
      const preview = await mergePreview(ctx, id)
      const ready = await prepareMerge(
        ctx,
        { id, revision: preview.revision, plugins: ['@fixture/new'], includeConfig: false },
        { install, run: runtime },
      )
      await expect(
        commitMerge(ctx, ready.id, {
          swap: async () => {
            throw new Error('fixture swap failure')
          },
        }),
      ).rejects.toThrow('fixture swap failure')
      expect(await readFile(join(home, 'profiles/web/node_modules/old.txt'), 'utf8')).toBe(
        'old-code',
      )
    } finally {
      await destroyTempHome(home)
    }
  })
})
describe('shared manager recursion guard', () => {
  test('derives one root, refuses nested/incorrect roots and does not copy the registry', async () => {
    const { id, home } = await seed()
    try {
      const child = labHomeDir(home, id)
      expect(managerHome(child)).toBe(home)
      expect(currentLabId(child)).toBe(id)
      expect(managerHome(child, id)).toBe(home)
      expect(managerHome(child, id, home)).toBe(home)
      expect(() => managerHome(child, id, child)).toThrow('不匹配')
      expect(() => managerHome(home, id, home)).toThrow('不匹配')
      const destination = join(home, 'independent')
      await inheritHome(home, destination, { skipPaths: ['independent'] })
      await expect(
        readFile(join(destination, 'world-line/labs', id, 'manifest.json')),
      ).rejects.toThrow()
      expect(managerHome(home)).toBe(home)
    } finally {
      await destroyTempHome(home)
    }
  })
})
