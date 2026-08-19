/**
 * Public configuration contract.
 *
 * The prototype this package grew from spread user config over a defaults
 * object, which meant a typo (`sessionTtlMS`) silently kept the default and a
 * hostile value (`maxSessions: 0`) was accepted. Everything is validated here
 * instead, and every bound has a reason: these numbers decide how much memory
 * an unauthenticated caller can cause the process to allocate.
 *
 * @module @seaveyon/dsh-web-login/config
 */

/** Defaults chosen for the deployment this package exists for: one operator, TLS at a proxy. */
export const DEFAULTS = Object.freeze({
  passwordHashEnv: 'LOGIN_PASSWORD_HASH',
  title: 'DSH Web',
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  secureCookie: true,
  maxBodyBytes: 4096,
  maxSessions: 10000,
  attemptLimit: 5,
  attemptWindowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  maxAttemptClients: 10000,
  sweepIntervalMs: 5 * 60 * 1000,
  trustProxy: false,
  clientIpHeader: 'x-forwarded-for',
})

/** Inclusive bounds for the numeric settings. */
const RANGES = Object.freeze({
  sessionTtlMs: [60 * 1000, 365 * 24 * 60 * 60 * 1000],
  maxBodyBytes: [64, 1024 * 1024],
  maxSessions: [1, 1000000],
  attemptLimit: [1, 1000],
  attemptWindowMs: [1000, 24 * 60 * 60 * 1000],
  blockMs: [1000, 24 * 60 * 60 * 1000],
  maxAttemptClients: [1, 1000000],
  sweepIntervalMs: [1000, 60 * 60 * 1000],
})

const MAX_TITLE_LENGTH = 120

/**
 * Validate and normalize plugin configuration.
 *
 * Unknown keys are rejected rather than ignored: a misspelled security setting
 * that appears to have been accepted is worse than a startup failure, because
 * the deployment then runs with a default the operator believes they changed.
 *
 * @param config - raw configuration from the dsh profile, possibly undefined.
 * @returns the normalized settings.
 * @throws when a value is of the wrong type, out of range, or unrecognized.
 */
export function resolveConfig(config = {}) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('dsh-web-login: config must be an object')
  }

  const unknown = Object.keys(config).filter((key) => !(key in DEFAULTS))
  if (unknown.length > 0) {
    throw new Error(`dsh-web-login: unknown config key(s): ${unknown.join(', ')}`)
  }

  const out = { ...DEFAULTS, ...config }

  for (const key of ['passwordHashEnv', 'clientIpHeader']) {
    const value = out[key]
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`dsh-web-login: ${key} must be a non-empty string`)
    }
  }
  // Names are passed to process.env and may later be written by the hash CLI;
  // permit only portable environment identifiers so they cannot smuggle a new
  // assignment into an env file.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.passwordHashEnv)) {
    throw new TypeError('dsh-web-login: passwordHashEnv must be a valid environment variable name')
  }
  // Header names are matched against Node's lowercased header map, so an
  // uppercase configured name would never match anything.
  out.clientIpHeader = out.clientIpHeader.toLowerCase()

  if (typeof out.title !== 'string' || out.title === '') {
    throw new TypeError('dsh-web-login: title must be a non-empty string')
  }
  if (out.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`dsh-web-login: title must be at most ${MAX_TITLE_LENGTH} characters`)
  }

  for (const key of ['secureCookie', 'trustProxy']) {
    if (typeof out[key] !== 'boolean') {
      throw new TypeError(`dsh-web-login: ${key} must be a boolean`)
    }
  }

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = out[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`dsh-web-login: ${key} must be an integer`)
    }
    if (value < min || value > max) {
      throw new RangeError(`dsh-web-login: ${key} must be between ${min} and ${max}`)
    }
  }

  return Object.freeze(out)
}
