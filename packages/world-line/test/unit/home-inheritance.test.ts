import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { load } from 'js-yaml'
import { inheritHome } from '../../src/lab/home-inheritance.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

describe('mirror home inheritance', () => {
  test('copies persistent data, filters runtime state, rebases paths and isolates links', async () => {
    const home = await makeTempHome()
    const external = await makeTempHome()
    const target = join(home, 'world-line/labs/mirror/home')
    const put = async (path: string, content = 'fixture') => {
      const full = join(home, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    try {
      await put('auth/dsh-web-login/github-users.json', '{"users":[{"role":"owner"}]}')
      for (const name of [
        'sessions.json',
        'sessions.json.bak-invalid',
        'recovery.json',
        'invitations.json',
      ])
        await put(`auth/dsh-web-login/${name}`)
      await put('sessions/chat/messages.jsonl')
      await put('storages/plugin/data.bin')
      await put('profiles/web/pnpm-lock.yaml')
      await put('profiles/web/cordis.yml')
      await put('profiles/web/node_modules/pkg/index.js')
      await put('runtime.pid')
      await put('.env', 'SECRET=fixture')
      await put('settings.yaml', `custom:\n  path: ${home}/storages/plugin\nui:\n  locale: zh-CN\n`)
      await put(
        '.credentials.yaml',
        'version: 1\nrefs:\n  CUSTOM_SECRET: fixture\nrecords:\n  browser:\n    kind: grant\n    payload: forbidden\n',
      )
      await symlink(join(home, 'storages/plugin'), join(home, 'storage-link'))
      // A sibling temporary home is external on every CI platform. Do not use
      // /tmp: it can resolve to the fixture root under a runner's temp setup.
      await symlink(external, join(home, 'external-link'))
      const result = await inheritHome(home, target)
      expect(await readFile(join(target, 'sessions/chat/messages.jsonl'), 'utf8')).toBe('fixture')
      expect(await readFile(join(target, 'storage-link/data.bin'), 'utf8')).toBe('fixture')
      await writeFile(join(target, 'storage-link/data.bin'), 'mirror change')
      expect(await readFile(join(home, 'storages/plugin/data.bin'), 'utf8')).toBe('fixture')
      expect(
        await readFile(join(target, 'auth/dsh-web-login/github-users.json'), 'utf8'),
      ).toContain('owner')
      expect((await stat(join(target, 'auth/dsh-web-login/github-users.json'))).mode & 0o777).toBe(
        0o600,
      )
      expect(result.skippedLinks).toEqual(['external-link'])
      for (const path of [
        'world-line',
        '.env',
        'runtime.pid',
        'profiles/web/node_modules',
        'profiles/web/cordis.yml',
        'auth/dsh-web-login/sessions.json',
        'auth/dsh-web-login/recovery.json',
      ])
        await expect(stat(join(target, path))).rejects.toThrow()
      expect(await readFile(join(target, 'profiles/web/pnpm-lock.yaml'), 'utf8')).toBe('fixture')
      const settings = load(await readFile(join(target, 'settings.yaml'), 'utf8'))
      expect(settings).toEqual({
        custom: { path: `${target}/storages/plugin` },
        ui: { locale: 'zh-CN' },
      })
      const credentials = await readFile(join(target, '.credentials.yaml'), 'utf8')
      expect(credentials).toContain('CUSTOM_SECRET')
      expect(credentials).not.toContain('forbidden')
      await inheritHome(home, target)
      expect(await readFile(join(target, 'storage-link/data.bin'), 'utf8')).toBe('mirror change')
    } finally {
      await destroyTempHome(home)
      await destroyTempHome(external)
    }
  })

  test('backfills missing data without replacing existing bindings, settings or credentials; respects opt-out', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      await mkdir(join(source, 'auth/dsh-web-login'), { recursive: true })
      await mkdir(join(target, 'auth/dsh-web-login'), { recursive: true })
      await writeFile(join(source, 'auth/dsh-web-login/github-users.json'), 'official')
      await writeFile(join(target, 'auth/dsh-web-login/github-users.json'), 'mirror')
      await writeFile(join(source, 'settings.yaml'), 'ui:\n  locale: zh-CN\n  theme: dark\n')
      await writeFile(join(target, 'settings.yaml'), 'ui:\n  locale: en\n')
      await writeFile(join(source, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: secret\n')
      await inheritHome(source, target, { apiKeys: false })
      expect(await readFile(join(target, 'auth/dsh-web-login/github-users.json'), 'utf8')).toBe(
        'mirror',
      )
      expect(load(await readFile(join(target, 'settings.yaml'), 'utf8'))).toEqual({
        ui: { locale: 'en', theme: 'dark' },
      })
      await expect(stat(join(target, '.credentials.yaml'))).rejects.toThrow()
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })

  test('refuses destination symlinks instead of writing into another home', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      await mkdir(join(source, 'data'))
      await writeFile(join(source, 'data/secret'), 'original')
      await symlink(join(source, 'data'), join(target, 'data'))
      await expect(inheritHome(source, target)).rejects.toThrow('symlink')
      expect(await readFile(join(source, 'data/secret'), 'utf8')).toBe('original')
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })
})
