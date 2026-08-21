/**
 * Generate and store the scrypt verifier the login plugin expects.
 *
 * Reads a password from a raw TTY prompt without echoing it — so it never lands
 * in shell history, terminal scrollback, or `ps` output — then writes only its
 * verifier to the dsh `.env` at mode 0600. The verifier itself is never printed:
 * a value echoed to a terminal is a value that lives in scrollback, in a
 * screenshot, and eventually in a pasted bug report.
 *
 * Usage: dsh-web-login-hash [--env-path <path>] [--var <NAME>]
 *
 * The path flag is `--env-path`, not `--env-file`, because Node itself owns
 * `--env-file`: it consumes that flag wherever it appears — even after the
 * script path — preloading the named file as a dotenv file and exiting 9 if it
 * does not exist. A CLI whose own `--env-file` names a file yet to be created
 * would therefore fail before its first line ran.
 *
 * The shebang is not written here. It is prepended at build time by the CLI
 * entry's `banner.js` in `rslib.config.ts`, because a shebang in the source
 * would sit in the middle of the bundled output rather than at the top of it.
 *
 * @module @seaveyon/dsh-web-login/hash-password
 */

import { writeSync } from 'node:fs'
import { argv, exit, stderr, stdout } from 'node:process'
import { DEFAULTS } from './config.js'
import { isEnvName, resolveEnvPath, writeEnvAssignment } from './env-file.js'
import { askHidden } from './prompt.js'
import { hashPassword, MAX_PASSWORD_BYTES } from './verifier.js'

/** Shortest password accepted. */
const MIN_LENGTH = 8

/** The resolved command line. */
interface CliOptions {
  envPath?: string
  varName: string
  help?: boolean
}

/**
 * Parse the command line.
 * @param args - argv slice after the script name.
 * @returns the resolved options.
 * @throws on an unknown or incomplete flag.
 */
function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { varName: DEFAULTS.passwordHashEnv }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    // Rejected by name rather than ignored, for the users this branch can still
    // reach. Node consumes a space-separated `--env-file <path>` and exits 9
    // before any line here runs, so that spelling is unreachable from inside the
    // process; the `--env-file=<path>` form Node passes through is not, and it
    // arrives here where the flag to use instead can be named.
    if (arg === '--env-file' || arg?.startsWith('--env-file=') === true) {
      throw new Error(
        'dsh-web-login-hash: --env-file is reserved by Node itself; use --env-path <path>',
      )
    }
    if (arg === '--env-path' || arg === '--var') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`dsh-web-login-hash: ${arg} requires a value`)
      }
      if (arg === '--env-path') options.envPath = value
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
  --env-path <path>  file to update (default: $DSH_HOME/.env, else ~/.dsh/.env)
  --var <NAME>       variable to set (default: ${DEFAULTS.passwordHashEnv})
  -h, --help         show this message
`

/**
 * Report a failure and exit.
 *
 * Every message that reaches here may name a path or a flag but never the
 * password or the verifier: this output is what gets pasted into bug reports.
 *
 * @param message - the text to write to stderr.
 * @param code - process exit status.
 * @returns never; the process exits after the synchronous write completes.
 */
function writeAndExit(stream: typeof stdout | typeof stderr, message: string, code: number): never {
  // `process.exit()` does not flush asynchronous stream writes. These messages
  // are short, and writing the standard-stream descriptor synchronously makes
  // help and diagnostics reliable through redirection and execFile/spawn.
  writeSync(stream.fd, message)
  return exit(code)
}

function fail(message: string, code: number): never {
  return writeAndExit(stderr, message, code)
}

function readOptions(): CliOptions {
  try {
    return parseArgs(argv.slice(2))
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`, 2)
  }
}

const options = readOptions()

if (options.help === true) {
  writeAndExit(stdout, USAGE, 0)
}

const envPath = options.envPath ?? resolveEnvPath()

/**
 * Prompt for a password, exiting with the prompt's own message on failure.
 * @param label - text shown before the hidden input.
 * @returns the entered line.
 */
async function ask(label: string): Promise<string> {
  try {
    return await askHidden(label)
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n`, 1)
  }
}

const password = await ask('New dsh access password: ')

if (password.length < MIN_LENGTH) {
  fail(`Refusing: use at least ${MIN_LENGTH} characters.\n`, 1)
}
if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
  fail(`Refusing: password exceeds ${MAX_PASSWORD_BYTES} bytes.\n`, 1)
}

const confirm = await ask('Confirm: ')
if (password !== confirm) {
  fail('Passwords did not match.\n', 1)
}

try {
  await writeEnvAssignment({
    path: envPath,
    key: options.varName,
    value: hashPassword(password),
  })
} catch (error) {
  // The message may name a path but never the verifier, so this is safe to show.
  fail(`${error instanceof Error ? error.message : String(error)}\n`, 1)
}

stdout.write(`Saved ${options.varName} to ${envPath} (mode 0600).\n`)
stdout.write('Restart dsh to activate the login gate.\n')
