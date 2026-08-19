/**
 * A fake TTY for exercising the hidden password prompt.
 *
 * The prompt's most important property — that it never echoes what is typed —
 * cannot be verified against a real terminal without printing a password into
 * the test log. A fake stream records every write instead, so the assertion
 * becomes "the output contains the prompt and nothing else".
 *
 * @module test/helpers/fake-tty
 */

import { EventEmitter } from 'node:events'

/**
 * Create a fake input/output pair.
 * @returns `input` (a TTY-like readable), `output` (a recording writable), and
 *   the accumulated `written` text.
 */
export function createFakeTty() {
  const input = new EventEmitter()
  input.isTTY = true
  input.isRaw = false
  input.rawModeCalls = []
  input.setRawMode = (value) => {
    input.isRaw = value
    input.rawModeCalls.push(value)
    return input
  }
  input.resume = () => input
  /**
   * Deliver keystrokes to the prompt.
   * @param text - characters to send as one chunk.
   */
  input.type = (text) => input.emit('data', Buffer.from(text, 'utf8'))

  const chunks = []
  const output = {
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    get written() {
      return chunks.join('')
    },
  }

  return { input, output }
}
