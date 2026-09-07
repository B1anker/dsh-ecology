import { expect, test } from '@rstest/core'
import { resolveConfig } from '../../src/config.js'
import {
  serializeClearedCookies,
  serializeSessionCookie,
  sessionCookieName,
} from '../../src/cookies.js'

test('each lab/rescue has a stable distinct namespace, even with a cloned explicit namespace', () => {
  const official = resolveConfig({ cookieNamespace: 'custom' }, {})
  const lab = resolveConfig({ cookieNamespace: 'custom' }, { WORLD_LINE_LAB: 'lab-a' })
  const again = resolveConfig({ cookieNamespace: 'custom' }, { WORLD_LINE_LAB: 'lab-a' })
  const other = resolveConfig({ cookieNamespace: 'custom' }, { WORLD_LINE_LAB: 'lab-b' })
  const rescue = resolveConfig({}, { WORLD_LINE_RESCUE: 'rescue-a' })
  expect(lab.cookieNamespace).toBe(again.cookieNamespace)
  expect(
    new Set([
      official.cookieNamespace,
      lab.cookieNamespace,
      other.cookieNamespace,
      rescue.cookieNamespace,
    ]).size,
  ).toBe(4)
  expect(resolveConfig({}, {}).cookieNamespace).toBe('')
})

test('namespaced cookies preserve host protection and logout never clears another namespace', () => {
  for (const secure of [true, false]) {
    const name = sessionCookieName(secure, 'lab_a')
    const set = serializeSessionCookie('fixture', { secure, namespace: 'lab_a', maxAgeSeconds: 60 })
    expect(set.startsWith(`${name}=`)).toBe(true)
    expect(set).toContain('Path=/; HttpOnly; SameSite=Strict')
    expect(set).not.toContain('Domain=')
    if (secure) {
      expect(name).toMatch(/^__Host-/)
      expect(set).toContain('; Secure')
    }
    for (const clear of serializeClearedCookies({ secure, namespace: 'lab_a' })) {
      expect(clear.split('=')[0]).toContain('dsh_session_lab_a')
      expect(clear).not.toMatch(/^dsh_session=/)
    }
  }
})

test('reject cookie namespace injection and overly long names', () => {
  for (const namespace of ['bad; Domain=example.com', 'bad\r\nHeader: x', 'x'.repeat(65)]) {
    expect(() => resolveConfig({ cookieNamespace: namespace }, {})).toThrow()
    expect(() => sessionCookieName(false, namespace)).toThrow()
  }
})
