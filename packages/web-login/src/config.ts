/**
 * Public configuration contract.
 *
 * The prototype this package grew from spread user config over a defaults
 * object, which meant a typo (`sessionTtlMS`) silently kept the default and a
 * hostile value (`maxSessions: 0`) was accepted. Everything is validated here
 * instead, and every bound has a reason: these numbers decide how much memory
 * an unauthenticated caller can cause the process to allocate.
 *
 * The runtime checks are not redundant with the types. Configuration arrives
 * from a YAML profile that TypeScript never sees, so `LoginConfig` describes
 * what a *caller in TypeScript* may pass, while the validation below is what
 * actually defends the process. Neither one substitutes for the other.
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
  // The backstop for a caller spread across many addresses, which per-client
  // counting cannot see. Well above any plausible number of honest typos in a
  // window, and the block it imposes is deliberately much shorter than the
  // per-client one, because this one can also catch the operator.
  globalAttemptLimit: 100,
  globalBlockMs: 60 * 1000,
  // One IPv4 address is one client. One IPv6 /64 is one customer allocation,
  // and treating its addresses separately would hand a single attacker
  // eighteen quintillion independent allowances.
  ipv4PrefixBits: 32,
  ipv6PrefixBits: 64,
  // Two of libuv's four default threadpool slots, leaving the other two for the
  // fs and DNS work the rest of dsh does. Past the queue a sign-in is refused
  // rather than delayed; see the kdf-gate module.
  kdfConcurrency: 2,
  kdfQueueDepth: 8,
})

/**
 * Broaden a literal type back to the primitive it is a member of.
 *
 * `Object.freeze` infers `2` rather than `number` for a numeric property, which
 * is what makes {@link DEFAULTS} a useful set of constants — and what would
 * otherwise make {@link LoginConfig} useless, since `{ maxSessions: 500 }` is
 * not assignable to `{ maxSessions: 10000 }`. The default *values* stay exact;
 * only the type derived for callers is widened.
 */
type Widen<T> = T extends boolean
  ? boolean
  : T extends number
    ? number
    : T extends string
      ? string
      : T

/**
 * Fully resolved settings.
 *
 * Derived from {@link DEFAULTS} so the two cannot drift: adding a default adds
 * a field here, and a field with no default is a compile error rather than an
 * `undefined` discovered at runtime.
 */
export type ResolvedConfig = Readonly<{
  -readonly [K in keyof typeof DEFAULTS]: Widen<(typeof DEFAULTS)[K]>
}>

/** Configuration as a caller may supply it: every key optional. */
export type LoginConfig = Partial<ResolvedConfig>

/** Keys holding a string value. */
type StringKey = 'passwordHashEnv' | 'clientIpHeader' | 'title'
/** Keys holding a boolean value. */
type BooleanKey = 'secureCookie' | 'trustProxy'
/** Keys holding an integer, each with an inclusive range. */
type NumericKey =
  | 'sessionTtlMs'
  | 'maxBodyBytes'
  | 'maxSessions'
  | 'attemptLimit'
  | 'attemptWindowMs'
  | 'blockMs'
  | 'maxAttemptClients'
  | 'sweepIntervalMs'
  | 'kdfConcurrency'
  | 'kdfQueueDepth'
  | 'globalAttemptLimit'
  | 'globalBlockMs'
  | 'ipv4PrefixBits'
  | 'ipv6PrefixBits'

/** Inclusive bounds for the numeric settings. */
const RANGES: Readonly<Record<NumericKey, readonly [number, number]>> = Object.freeze({
  sessionTtlMs: [60 * 1000, 365 * 24 * 60 * 60 * 1000],
  maxBodyBytes: [64, 1024 * 1024],
  maxSessions: [1, 1000000],
  attemptLimit: [1, 1000],
  attemptWindowMs: [1000, 24 * 60 * 60 * 1000],
  blockMs: [1000, 24 * 60 * 60 * 1000],
  maxAttemptClients: [1, 1000000],
  sweepIntervalMs: [1000, 60 * 60 * 1000],
  // The ceiling is deliberately low. Each slot is 16 MiB of scrypt working
  // memory held by an unauthenticated caller, and the point of the setting is
  // to bound that, so a value large enough to defeat it is a configuration
  // error rather than a choice.
  kdfConcurrency: [1, 32],
  // Zero is legal and means "no waiting at all": once every slot is busy, a
  // further sign-in is refused immediately.
  kdfQueueDepth: [0, 1024],
  globalAttemptLimit: [1, 1000000],
  globalBlockMs: [1000, 24 * 60 * 60 * 1000],
  // The floors matter more than the ceilings. A /0 would put every client on
  // Earth in one bucket, which throttles the operator on a stranger's behalf;
  // these are the widest buckets that still separate unrelated networks.
  ipv4PrefixBits: [8, 32],
  ipv6PrefixBits: [32, 128],
})

const STRING_KEYS: readonly StringKey[] = ['passwordHashEnv', 'clientIpHeader', 'title']
const BOOLEAN_KEYS: readonly BooleanKey[] = ['secureCookie', 'trustProxy']

const MAX_TITLE_LENGTH = 120

/**
 * Validate and normalize plugin configuration.
 *
 * Unknown keys are rejected rather than ignored: a misspelled security setting
 * that appears to have been accepted is worse than a startup failure, because
 * the deployment then runs with a default the operator believes they changed.
 *
 * The parameter is typed `unknown` rather than `LoginConfig`, because the real
 * argument comes from a parsed YAML profile. Accepting the narrower type here
 * would let a caller pass an object TypeScript believes is valid while the
 * validation below exists precisely for the case where it is not.
 *
 * @param config - raw configuration from the dsh profile, possibly undefined.
 * @returns the normalized settings.
 * @throws when a value is of the wrong type, out of range, or unrecognized.
 */
export function resolveConfig(config: unknown = {}): ResolvedConfig {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('dsh-web-login: config must be an object')
  }

  const supplied = config as Record<string, unknown>
  const unknown = Object.keys(supplied).filter((key) => !Object.hasOwn(DEFAULTS, key))
  if (unknown.length > 0) {
    throw new Error(`dsh-web-login: unknown config key(s): ${unknown.join(', ')}`)
  }

  // Built as a mutable record because validation rewrites one field
  // (`clientIpHeader`) in place; it is frozen and narrowed on return.
  const out: Record<string, unknown> = { ...DEFAULTS, ...supplied }

  for (const key of STRING_KEYS) {
    const value = out[key]
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`dsh-web-login: ${key} must be a non-empty string`)
    }
  }
  // Names are passed to process.env and may later be written by the hash CLI;
  // permit only portable environment identifiers so they cannot smuggle a new
  // assignment into an env file.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(out.passwordHashEnv as string)) {
    throw new TypeError('dsh-web-login: passwordHashEnv must be a valid environment variable name')
  }
  // Header names are matched against Node's lowercased header map, so an
  // uppercase configured name would never match anything.
  out.clientIpHeader = (out.clientIpHeader as string).toLowerCase()

  const title = out.title as string
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`dsh-web-login: title must be at most ${MAX_TITLE_LENGTH} characters`)
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof out[key] !== 'boolean') {
      throw new TypeError(`dsh-web-login: ${key} must be a boolean`)
    }
  }

  for (const key of Object.keys(RANGES) as NumericKey[]) {
    const [min, max] = RANGES[key]
    const value = out[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`dsh-web-login: ${key} must be an integer`)
    }
    if (value < min || value > max) {
      throw new RangeError(`dsh-web-login: ${key} must be between ${min} and ${max}`)
    }
  }

  return Object.freeze(out) as ResolvedConfig
}
