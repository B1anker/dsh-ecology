import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askHidden } from '../../src/prompt.js'
import { createFakeTty } from '../helpers/fake-tty.js'

const CTRL_C = String.fromCharCode(3)
const CTRL_D = String.fromCharCode(4)
const ESC = String.fromCharCode(27)
const BACKSPACE = String.fromCharCode(8)
const DELETE = String.fromCharCode(127)

test('the prompt reads a line without echoing it', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('Password: ', { input, output })
  input.type('hunter2\r')
  assert.equal(await pending, 'hunter2')
  // The property that matters: nothing typed appears in the terminal, so a
  // password cannot end up in scrollback or a screen share.
  assert.equal(output.written, 'Password: \n')
  assert.ok(!output.written.includes('hunter2'))
})

test('either newline convention ends the line', async () => {
  for (const terminator of ['\r', '\n', '\r\n']) {
    const { input, output } = createFakeTty()
    const pending = askHidden('> ', { input, output })
    input.type(`secret${terminator}`)
    assert.equal(await pending, 'secret')
  }
})

test('input arriving one keystroke at a time is assembled', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  for (const character of 'abc') input.type(character)
  input.type('\r')
  assert.equal(await pending, 'abc')
})

test('backspace deletes the previous character', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`abcX${DELETE}\r`)
  assert.equal(await pending, 'abc')
})

test('backspace on an empty buffer is harmless', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`${DELETE}${DELETE}${BACKSPACE}a\r`)
  assert.equal(await pending, 'a')
})

test('Ctrl-C and Ctrl-D cancel', async () => {
  for (const key of [CTRL_C, CTRL_D]) {
    const { input, output } = createFakeTty()
    const pending = askHidden('> ', { input, output })
    input.type(`partial${key}`)
    await assert.rejects(pending, /cancelled/)
  }
})

test('control bytes are dropped rather than entering the password', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(`a${ESC}b\r`)
  assert.equal(await pending, 'ab')
})

test('multibyte characters survive intact', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('密码é🔑\r')
  assert.equal(await pending, '密码é🔑')
})

test('raw mode is enabled for the read and restored afterwards', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  assert.equal(input.isRaw, true, 'raw mode is what suppresses the echo')
  input.type('x\r')
  await pending
  assert.deepEqual(input.rawModeCalls, [true, false])
  assert.equal(input.isRaw, false)
})

test('a terminal already in raw mode is left in raw mode', async () => {
  const { input, output } = createFakeTty()
  input.isRaw = true
  const pending = askHidden('> ', { input, output })
  input.type('x\r')
  await pending
  assert.deepEqual(input.rawModeCalls, [true, true])
})

test('raw mode is restored even when the read is cancelled', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type(CTRL_C)
  await assert.rejects(pending)
  assert.equal(input.isRaw, false)
})

test('the stdin listener is removed once the read finishes', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('x\r')
  await pending
  assert.equal(input.listenerCount('data'), 0)
  // A stray keystroke after settling must not reach a resolved promise.
  input.type('leftover\r')
})

test('a non-TTY input is refused rather than read unprotected', async () => {
  const { input, output } = createFakeTty()
  input.isTTY = false
  // Without raw mode the password would be echoed; a piped password would also
  // sit in shell history or a script, so refusing is the honest answer.
  await assert.rejects(
    askHidden('> ', { input, output }),
    /must run in an interactive terminal/,
  )
  assert.equal(output.written, '', 'not even the prompt should be printed')
})

test('an empty line is a valid read; length policy belongs to the caller', async () => {
  const { input, output } = createFakeTty()
  const pending = askHidden('> ', { input, output })
  input.type('\r')
  assert.equal(await pending, '')
})
