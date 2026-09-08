import type { IncomingMessage } from 'node:http'
import { describe, expect, test } from '@rstest/core'
import { createLabSessionGate } from '../../src/lab-session.js'

const id = 'lab-20260908T061328Z-b7ba1266'
const secret = 'a'.repeat(64)
const env = {
  WORLD_LINE_LAB: id,
  WORLD_LINE_SESSION_SECRET: secret,
  WORLD_LINE_SESSION_EXPIRES: '601000',
  WORLD_LINE_MANAGER_HOME: '/manager',
  DSH_HOME: `/manager/world-line/labs/${id}/home`,
}
const request = (value: string, remote = '127.0.0.1') =>
  ({
    headers: { 'x-world-line-session': value },
    socket: { remoteAddress: remote },
  }) as unknown as IncomingMessage

describe('lab-scoped delegation', () => {
  test('requires an exact target, loopback connection, secret and bounded expiry', () => {
    const gate = createLabSessionGate(
      env,
      () => 1000,
      (req) => req.headers['x-world-line-session'] === secret,
    )
    expect(gate(request(secret))).toBe(true)
    expect(gate(request('b'.repeat(64)))).toBe(false)
    expect(gate(request(secret, '10.0.0.1'))).toBe(false)
    expect(
      createLabSessionGate({ ...env, DSH_HOME: '/manager' }, () => 1000)(request(secret)),
    ).toBe(false)
    expect(
      createLabSessionGate(
        { ...env, WORLD_LINE_SESSION_EXPIRES: '601001' },
        () => 1000,
      )(request(secret)),
    ).toBe(false)
  })
  test('expires in memory and is disabled by default', () => {
    let now = 1000
    const gate = createLabSessionGate(
      env,
      () => now,
      () => true,
    )
    now = 601000
    expect(gate(request(secret))).toBe(false)
    expect(
      createLabSessionGate(
        {},
        () => 1000,
        () => true,
      )(request(secret)),
    ).toBe(false)
    expect(createLabSessionGate(env, () => 1000)(request(secret))).toBe(false)
  })
})
