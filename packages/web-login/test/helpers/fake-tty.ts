/**
 * A fake TTY for exercising the hidden password prompt.
 *
 * The prompt's most important property — that it never echoes what is typed —
 * cannot be verified against a real terminal without printing a password into
 * the test log. A fake stream records every write instead, so the assertion
 * becomes "the output contains the prompt and nothing else".
 *
 * No cast is needed here. `askHidden` declares its streams structurally
 * (`PromptInput`/`PromptOutput`) precisely so this file can satisfy them, which
 * means a change to what the prompt needs breaks this helper at compile time
 * rather than at run time.
 *
 * @module test/helpers/fake-tty
 */

import { EventEmitter } from 'node:events'
import type { PromptInput, PromptOutput } from '../../src/prompt.js'

/** The input half: a TTY-like emitter that records raw-mode transitions. */
export interface FakeInput extends PromptInput {
  isTTY: boolean
  isRaw: boolean
  /** Every value passed to `setRawMode`, in order. */
  rawModeCalls: boolean[]
  /** Deliver keystrokes to the prompt as one chunk. */
  type: (text: string) => void
  /**
   * How many listeners are attached for an event.
   *
   * Not part of {@link PromptInput}: the prompt never asks. It is here because
   * "the handler was removed once the read settled" is a leak the tests must be
   * able to see, and a count is the only way to see it from outside.
   */
  listenerCount: (event: 'data') => number
}

/** The output half: a writable that accumulates what was written. */
export interface FakeOutput extends PromptOutput {
  readonly written: string
}

/**
 * Create a fake input/output pair.
 * @returns `input` (a TTY-like readable) and `output` (a recording writable).
 */
export function createFakeTty(): { input: FakeInput; output: FakeOutput } {
  const emitter = new EventEmitter()
  const input: FakeInput = {
    isTTY: true,
    isRaw: false,
    rawModeCalls: [],
    setRawMode(value: boolean) {
      input.isRaw = value
      input.rawModeCalls.push(value)
      return input
    },
    resume: () => input,
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    listenerCount: (event) => emitter.listenerCount(event),
    type: (text: string) => {
      emitter.emit('data', Buffer.from(text, 'utf8'))
    },
  }

  const chunks: string[] = []
  const output: FakeOutput = {
    write(chunk: string) {
      chunks.push(String(chunk))
      return true
    },
    get written() {
      return chunks.join('')
    },
  }

  return { input, output }
}
