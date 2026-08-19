#!/usr/bin/env node
/**
 * Generate and store the scrypt verifier the login plugin expects.
 *
 * Reads a password from a raw TTY prompt without echoing it — so it never lands
 * in shell history, terminal scrollback, or `ps` output — then writes only its
 * verifier to the dsh `.env` at mode 0600. The verifier itself is never printed:
 * a value echoed to a terminal is a value that lives in scrollback, in a
 * screenshot, and eventually in a pasted bug report.
 *
 * Usage: npx dsh-web-login-hash [--env-file <path>] [--var <NAME>]
 */

import { argv, exit, stderr, stdout } from 'node:process'
import { DEFAULTS } from '../src/config.js'
import { isEnvName, resolveEnvPath, writeEnvAssignment } from '../src/env-file.js'
import { askHidden } from '../src/prompt.js'
import { hashPassword, MAX_PASSWORD_BYTES } from '../src/verifier.js'

/** Shortest password accepted. */
const MIN_LENGTH = 8

/**
 * Parse the command line.
 * @param args - argv slice after the script name.
 * @returns the resolved options.
 * @throws on an unknown or incomplete flag.
 */
function parseArgs(args) {
  const options = { envFile: undefined, varName: DEFAULTS.passwordHashEnv }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--env-file' || arg === '--var') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`dsh-web-login-hash: ${arg} requires a value`)
      }
      if (arg === '--env-file') options.envFile = value
      else {
        if (!isEnvName(value)) {
          throw new Error('dsh-web-login-hash: --var must be a valid environment variable name')
        }
        options.varName = value
      }
      i += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    throw new Error(`dsh-web-login-hash: unknown argument ${arg}`)
  }
  return options
}

const USAGE = `Usage: dsh-web-login-hash [options]

Options:
  --env-file <path>  file to update (default: $DSH_HOME/.env, else ~/.dsh/.env)
  --var <NAME>       variable to set (default: ${DEFAULTS.passwordHashEnv})
  -h, --help         show this message
`

let options
try {
  options = parseArgs(argv.slice(2))
} catch (error) {
  stderr.write(`${error.message}\n\n${USAGE}`)
  exit(2)
}

if (options.help) {
  stdout.write(USAGE)
  exit(0)
}

const envPath = options.envFile ?? resolveEnvPath()

let password
try {
  password = await askHidden('New dsh access password: ')
} catch (error) {
  stderr.write(`${error.message}\n`)
  exit(1)
}

if (password.length < MIN_LENGTH) {
  stderr.write(`Refusing: use at least ${MIN_LENGTH} characters.\n`)
  exit(1)
}
if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
  stderr.write(`Refusing: password exceeds ${MAX_PASSWORD_BYTES} bytes.\n`)
  exit(1)
}

let confirm
try {
  confirm = await askHidden('Confirm: ')
} catch (error) {
  stderr.write(`${error.message}\n`)
  exit(1)
}
if (password !== confirm) {
  stderr.write('Passwords did not match.\n')
  exit(1)
}

try {
  await writeEnvAssignment({
    path: envPath,
    key: options.varName,
    value: hashPassword(password),
  })
} catch (error) {
  // The message may name a path but never the verifier, so this is safe to show.
  stderr.write(`${error.message}\n`)
  exit(1)
}

stdout.write(`Saved ${options.varName} to ${envPath} (mode 0600).\n`)
stdout.write('Restart dsh to activate the login gate.\n')
