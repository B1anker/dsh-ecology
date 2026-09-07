import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { load } from 'js-yaml'

import { inheritModelConfiguration } from '../../src/lab/model-config.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

describe('mirror model and API key inheritance', () => {
  test('copies API keys and model routes, excludes browser/OAuth grants and unrelated secrets', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      const settings =
        'llm-pi-ai:\n  providers:\n    custom:\n      apiKeyEnv: CUSTOM_TOKEN\n      baseURL: https://fixture.invalid\nagent-default-model:\n  provider: custom\n  model: test\nui-theme:\n  preference: dark\n'
      const secrets =
        'version: 1\nrefs:\n  CUSTOM_TOKEN: fixture-custom\n  DEEPSEEK_API_KEY: fixture-deepseek\n  LOGIN_PASSWORD_HASH: do-not-copy\nrecords:\n  provider/test:\n    kind: api-key\n    key: fixture-record\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: do-not-copy-browser\n  oauth/test:\n    kind: grant\n    payload: do-not-copy-oauth\n'
      await writeFile(join(source, 'settings.yaml'), settings)
      await writeFile(join(source, '.credentials.yaml'), secrets)
      await inheritModelConfiguration(source, target)
      const copied = await readFile(join(target, '.credentials.yaml'), 'utf8')
      expect(copied).toContain('fixture-custom')
      expect(copied).toContain('fixture-deepseek')
      expect(copied).toContain('fixture-record')
      expect(copied).not.toContain('do-not-copy')
      expect(await readFile(join(target, 'settings.yaml'), 'utf8')).not.toContain('ui-theme')
      expect((await stat(join(target, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(target, 'settings.yaml'))).mode & 0o777).toBe(0o600)
      await writeFile(join(target, '.credentials.yaml'), 'version: 1\nrefs: {}\n')
      expect(await readFile(join(source, '.credentials.yaml'), 'utf8')).toBe(secrets)
      expect(await readFile(join(source, 'settings.yaml'), 'utf8')).toBe(settings)
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })

  test('existing mirror edits and its own browser credential survive backfill', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      await writeFile(
        join(source, 'settings.yaml'),
        'agent-default-model:\n  provider: original\n  model: original\n',
      )
      await writeFile(
        join(target, 'settings.yaml'),
        'agent-default-model:\n  provider: experiment\nui-theme:\n  preference: light\n',
      )
      await writeFile(
        join(source, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: original\n  GPT_API_KEY: add-me\n',
      )
      await writeFile(
        join(target, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: experiment\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload: keep-me\n',
      )
      await inheritModelConfiguration(source, target)
      const data = load(await readFile(join(target, '.credentials.yaml'), 'utf8'))
      expect(data).toMatchObject({
        refs: { DEEPSEEK_API_KEY: 'experiment', GPT_API_KEY: 'add-me' },
        records: { 'client-connection/browser-session': { payload: 'keep-me' } },
      })
      expect(load(await readFile(join(target, 'settings.yaml'), 'utf8'))).toMatchObject({
        'agent-default-model': { provider: 'experiment' },
        'ui-theme': { preference: 'light' },
      })
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })

  test('opt-out inherits model settings without reading or creating credentials', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      await writeFile(
        join(source, 'settings.yaml'),
        'agent-default-model:\n  provider: deepseek-official\n',
      )
      await writeFile(join(source, '.credentials.yaml'), 'invalid: [SECRET_FIXTURE')
      await inheritModelConfiguration(source, target, { apiKeys: false })
      await expect(stat(join(target, '.credentials.yaml'))).rejects.toThrow()
      expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toContain('deepseek-official')
      await expect(inheritModelConfiguration(source, target)).rejects.toThrow(
        'cannot read model configuration from .credentials.yaml',
      )
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })

  test('missing files are optional', async () => {
    const source = await makeTempHome()
    const target = await makeTempHome()
    try {
      await inheritModelConfiguration(source, target)
      await expect(stat(join(target, '.credentials.yaml'))).rejects.toThrow()
      await expect(stat(join(target, 'settings.yaml'))).rejects.toThrow()
    } finally {
      await destroyTempHome(source)
      await destroyTempHome(target)
    }
  })
})
