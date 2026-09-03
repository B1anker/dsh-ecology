/**
 * Create a one-time host-local recovery token for dsh-web-login.
 *
 * Only useful when GitHub OAuth is enabled and the operator has lost access to
 * every authorized account. The token is printed once; only its digest is
 * stored. Visiting `/auth/recovery?token=…` consumes it and opens a short
 * recovery session that can re-bind the owner.
 *
 * Usage: dsh-web-login-recovery [--ttl-ms <ms>]
 *
 * The shebang is prepended at build time by the CLI entry's `banner.js`.
 *
 * @module @seaveyon/dsh-web-login/create-recovery
 */

import { writeSync } from 'node:fs'
import { argv, exit, stderr, stdout } from 'node:process'
import { defaultRecoveryPath, mintRecoveryToken, saveRecoveryRecord } from './authorization.js'
import { DEFAULTS } from './config.js'

/** The resolved command line. */
interface CliOptions {
  ttlMs: number
  recoveryPath?: string
  help?: boolean
}

/**
 * Parse the command line.
 * @param args - argv slice after the script name.
 * @returns the resolved options.
 */
function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { ttlMs: DEFAULTS.recoveryTtlMs }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--ttl-ms' || arg === '--recovery-path') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`dsh-web-login-recovery: ${arg} requires a value`)
      }
      if (arg === '--ttl-ms') {
        const ttlMs = Number(value)
        if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60 * 1000) {
          throw new Error(
            'dsh-web-login-recovery: --ttl-ms must be an integer between 60000 and 3600000',
          )
        }
        options.ttlMs = ttlMs
      } else {
        options.recoveryPath = value
      }
      i += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    throw new Error(`dsh-web-login-recovery: unknown argument ${arg}`)
  }
  return options
}

const USAGE = `Usage: dsh-web-login-recovery [options]

Create a one-time recovery token for re-binding the GitHub owner.
The token is printed once; store only the URL you need.

Options:
  --ttl-ms <ms>          token lifetime (default: ${DEFAULTS.recoveryTtlMs})
  --recovery-path <path> recovery state file (default: $DSH_HOME/auth/dsh-web-login/recovery.json)
  -h, --help             show this message
`

/**
 * Report a failure and exit.
 * @param message - the text to write to stderr.
 */
function fail(message: string): never {
  writeSync(stderr.fd, `${message}\n`)
  exit(1)
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(argv.slice(2))
  } catch (error) {
    fail(error instanceof Error ? error.message : 'dsh-web-login-recovery: invalid arguments')
  }
  if (options.help === true) {
    writeSync(stdout.fd, `${USAGE}\n`)
    exit(0)
  }

  const path = options.recoveryPath ?? defaultRecoveryPath()
  const { token, digest } = mintRecoveryToken()
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + options.ttlMs)
  await saveRecoveryRecord(path, {
    tokenDigest: digest,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })

  // Print the token once. Never echo the digest beside it in a way that invites
  // pasting both into a ticket — the URL is enough for the operator.
  writeSync(
    stdout.fd,
    [
      'Recovery token created. It expires in ten minutes by default and is single-use.',
      `Open: /auth/recovery?token=${token}`,
      'After recovery, bind a GitHub owner again before normal access resumes.',
      '',
    ].join('\n'),
  )
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : 'dsh-web-login-recovery: unexpected failure')
})
