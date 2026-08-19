/**
 * Hidden password entry on a raw TTY.
 *
 * Written against raw `data` events rather than `readline`. An earlier version
 * created a readline Interface while separately iterating stdin; closing the
 * Interface aborted the competing iterator and surfaced an unhandled
 * AbortError. Raw events need neither, and handle Ctrl-C and Backspace without
 * a second stdin consumer.
 *
 * The streams are parameters so tests can drive a fake TTY and assert that
 * nothing is echoed — the property that matters most here, and the one that
 * cannot be checked by hand without leaking the password into scrollback.
 *
 * @module @seaveyon/dsh-web-login/prompt
 */

/** Ctrl-C. Written as an escape so the source stays free of control bytes. */
const ETX = '\u0003'
/** Ctrl-D. */
const EOT = '\u0004'
/** DEL, which is what most terminals send for Backspace. */
const DEL = '\u007f'

/**
 * Read one line without echoing it.
 *
 * @param prompt - text to display before accepting input.
 * @param streams - `input` and `output` streams; defaults to the process TTY.
 * @returns the entered line.
 * @throws when the input is not a TTY, or the user cancels.
 */
export function askHidden(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (input.isTTY !== true) {
    return Promise.reject(new Error(
      'dsh-web-login: this command must run in an interactive terminal',
    ))
  }

  output.write(prompt)
  const wasRaw = input.isRaw === true
  input.setRawMode(true)
  input.resume()

  return new Promise((resolve, reject) => {
    let value = ''
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      input.off('data', onData)
      input.setRawMode(wasRaw)
      output.write('\n')
      if (error !== undefined) reject(error)
      else resolve(value)
    }

    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        // Terminals send CR, LF, or occasionally both for Enter. The first one
        // settles and removes the handler, so a trailing LF is harmless.
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === ETX || character === EOT) {
          finish(new Error('dsh-web-login: password entry cancelled'))
          return
        }
        if (character === DEL || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        // Ignore escape sequences and other control codes rather than letting a
        // stray key chord become part of a password.
        if (character >= ' ') value += character
      }
    }

    input.on('data', onData)
  })
}
