import { expect, test } from '@rstest/core'
import { askHidden } from '../../src/prompt.js'
import { createFakeTty } from '../helpers/fake-tty.js'

// Built from character codes rather than written as escapes so this file, like
// the module it tests, contains no raw control bytes — a control byte in source
// is invisible in review and in a diff.
const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const ESC = String.fromCharCode(27)
const BACKSPACE = String.fromCharCode(8)
const DELETE = String.fromCharCode(127)

test('the prompt reads a line without echoing it', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('Password: ', { input, output })
  input.type('hunter2\r')
  expect(await pending).toBe('hunter2')
  // The property that matters: nothing typed appears in the terminal, so a
  // password cannot end up in scrollback or a screen share.
  expect(output.written).toBe('Password: \n')
  expect(output.written.includes('hunter2')).toBe(false)
})

test('either newline convention ends the line', async () => {
  for (const terminator of ['\r', '\n', '\r\n']) {
    const { input, output } = createFakeTty()
    const pending = askHidden('> ', { input, output })
    input.type(`secret${terminator}`)
    expect(await pending, JSON.stringify(terminator)).toBe('secret')
  }
})

test('input arriving one keystroke at a time is assembled', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  for (const character of 'abc') input.type(character)
  input.type('\r')
  expect(await pending).toBe('abc')
})

test('backspace deletes the previous character', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`abcX${DELETE}\r`)
  expect(await pending).toBe('abc')
})

test('backspace on an empty buffer is harmless', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`${DELETE}${DELETE}${BACKSPACE}a\r`)
  expect(await pending).toBe('a')
})

test('Ctrl-C and Ctrl-D cancel', async () => {
  for (const key of [CTRL_C, CTRL_D]) {
    const { input, output } = createFakeTty()
    const pending = askHidden('> ', { input, output })
    input.type(`partial${key}`)
    await expect(pending).rejects.toThrow(/cancelled/)
  }
})

test('control bytes are dropped rather than entering the password', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`a${ESC}b\r`)
  expect(await pending).toBe('ab')
})

test('multibyte characters survive intact', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('密码é🔑\r')
  expect(await pending).toBe('密码é🔑')
})

test('raw mode is enabled for the read and restored afterwards', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  expect(input.isRaw, 'raw mode is what suppresses the echo').toBe(true)
  input.type('x\r')
  await pending
  expect(input.rawModeCalls).toEqual([true, false])
  expect(input.isRaw).toBe(false)
})

test('a terminal already in raw mode is left in raw mode', async () => {
  const { input, output } = createFakeTty()
  input.isRaw = true
  const pending = askHidden('> ', { input, output })
  input.type('x\r')
  await pending
  expect(input.rawModeCalls).toEqual([true, true])
})

test('raw mode is restored even when the read is cancelled', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(CTRL_C)
  await expect(pending).rejects.toThrow()
  // A terminal left in raw mode after a Ctrl-C is a shell that no longer echoes
  // anything the operator types.
  expect(input.isRaw).toBe(false)
})

test('the stdin listener is removed once the read finishes', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('x\r')
  await pending
  expect(input.listenerCount('data')).toBe(0)
  // A stray keystroke after settling must not reach a resolved promise.
  input.type('leftover\r')
})

test('a non-TTY input is refused rather than read unprotected', async () => {
  const { input, output } = createFakeTty()
  input.isTTY = false
  // Without raw mode the password would be echoed; a piped password would also
  // sit in shell history or a script, so refusing is the honest answer.
  await expect(askHidden('> ', { input, output })).rejects.toThrow(
    /must run in an interactive terminal/,
  )
  expect(output.written, 'not even the prompt should be printed').toBe('')
})

test('an empty line is a valid read; length policy belongs to the caller', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('\r')
  expect(await pending).toBe('')
})
