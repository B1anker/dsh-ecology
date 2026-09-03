import { expect, test } from '@rstest/core'
import { DICTS, EN, LOCALE_NS, ZH } from '../../src/client/locales.js'
import { githubOAuthAppUrl } from '../../src/client/session.js'

test('locale namespace is stable for the shell registry', () => {
  expect(LOCALE_NS).toBe('settings.web-login')
})

test('zh and en dictionaries expose the same keys', () => {
  expect(Object.keys(ZH).toSorted()).toEqual(Object.keys(EN).toSorted())
  expect(DICTS.zh).toBe(ZH)
  expect(DICTS.en).toBe(EN)
  expect(ZH.nav).toBe('账户')
  expect(EN.nav).toBe('Account')
  expect(ZH.remainingDays).toContain('{count}')
  expect(EN.remainingDays).toContain('{count}')
})

test('githubOAuthAppUrl deep-links a configured numeric application id', () => {
  expect(githubOAuthAppUrl(1_234_567)).toBe('https://github.com/settings/applications/1234567')
  expect(githubOAuthAppUrl(null)).toBe('https://github.com/settings/developers')
  expect(githubOAuthAppUrl(0)).toBe('https://github.com/settings/developers')
  expect(githubOAuthAppUrl()).toBe('https://github.com/settings/developers')
})
