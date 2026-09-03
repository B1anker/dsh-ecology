import { expect, test } from '@rstest/core'
import { isDshWebCommand, spawnDetached, splitCommandLine } from '../../src/restart-dsh.js'

test('isDshWebCommand recognizes web boots and ignores helpers', () => {
  expect(isDshWebCommand('dsh web')).toBe(true)
  expect(isDshWebCommand('dsh web --host 127.0.0.1 --port 3080 --no-open')).toBe(true)
  expect(isDshWebCommand('node /path/bin/dsh web --port 3080')).toBe(true)
  expect(isDshWebCommand('dsh --profile web')).toBe(true)
  expect(isDshWebCommand('dsh --profile web --port 3080')).toBe(true)
  expect(isDshWebCommand('dsh plugin --profile web exec dsh-web-login-hash')).toBe(false)
  expect(isDshWebCommand('dsh-web-login-hash')).toBe(false)
  expect(isDshWebCommand('dsh --profile headless "run tests"')).toBe(false)
  expect(isDshWebCommand('nginx')).toBe(false)
})

test('splitCommandLine keeps simple dsh argv intact', () => {
  expect(splitCommandLine('dsh web --host 127.0.0.1 --port 3080')).toEqual([
    'dsh',
    'web',
    '--host',
    '127.0.0.1',
    '--port',
    '3080',
  ])
  expect(splitCommandLine(`node "/path/with space/dsh" web`)).toEqual([
    'node',
    '/path/with space/dsh',
    'web',
  ])
})

test('spawnDetached returns a pid and does not keep the parent waiting', () => {
  const pid = spawnDetached([process.execPath, '-e', 'setTimeout(() => {}, 30_000)'])
  expect(pid).toEqual(expect.any(Number))
  process.kill(pid!, 0)
  process.kill(pid!, 'SIGTERM')
})
