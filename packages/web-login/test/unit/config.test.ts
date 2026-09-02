import { expect, test } from '@rstest/core'
import { defaultAuthorizationPath, defaultRecoveryPath } from '../../src/authorization.js'
import { DEFAULTS, type LoginConfig, resolveConfig, resolvePublicUrl } from '../../src/config.js'

/**
 * Feed `resolveConfig` a value it is documented to reject.
 *
 * Every rejection case here is deliberately ill-typed — that is the point of the
 * test. The cast is confined to this one function so the suite says `bad(...)`
 * instead of carrying an `as LoginConfig` on each of the forty call sites, where
 * it would read as a type the author intended rather than as one under test.
 *
 * @param config - the invalid value to resolve.
 * @returns a thunk `expect(...).toThrow` can invoke.
 */
function bad(config: unknown): () => unknown {
  return () => resolveConfig(config as LoginConfig)
}

/** Defaults after path resolution, which depends on DSH_HOME. */
function resolvedDefaults(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...DEFAULTS,
    authorizationFile: defaultAuthorizationPath(env),
    recoveryFile: defaultRecoveryPath(env),
  }
}

test('an absent config yields the documented defaults', () => {
  expect({ ...resolveConfig() }).toEqual(resolvedDefaults())
  expect({ ...resolveConfig({}) }).toEqual(resolvedDefaults())
})

test('the resolved config is frozen', () => {
  const options = resolveConfig()
  expect(Object.isFrozen(options)).toBe(true)
  expect(() => {
    // A frozen config is what stops a later plugin from lowering a limit at
    // runtime, so the assignment has to be attempted to prove it fails.
    ;(options as { secureCookie: boolean }).secureCookie = false
  }).toThrow(TypeError)
})

test('unknown keys are rejected rather than ignored', () => {
  // A misspelled security setting that appears to have been accepted is worse
  // than a startup failure: the deployment then runs with a default the
  // operator believes they changed.
  expect(bad({ sessionTtlMS: 1000 })).toThrow(/unknown config key\(s\): sessionTtlMS/)
  expect(bad({ secure: true, ttl: 1 })).toThrow(/secure, ttl/)
  // `in` would accept these through Object.prototype even though none is a
  // configuration key. YAML can produce them as ordinary own properties, so
  // the allowlist must check DEFAULTS itself rather than its prototype chain.
  for (const key of ['constructor', 'toString', '__proto__']) {
    const supplied = Object.create(null) as Record<string, unknown>
    supplied[key] = 'not a setting'
    expect(bad(supplied), key).toThrow(new RegExp(`unknown config key\\(s\\): ${key}`))
  }
})

test('a non-object config is rejected', () => {
  for (const value of [null, 'x', 42, true]) {
    expect(bad(value), `expected a TypeError for ${JSON.stringify(value)}`).toThrow(TypeError)
  }
})

test('string settings must be non-empty strings', () => {
  for (const key of ['passwordHashEnv', 'clientIpHeader', 'title'] as const) {
    expect(bad({ [key]: '' }), `${key} empty`).toThrow(TypeError)
    expect(bad({ [key]: 42 }), `${key} non-string`).toThrow(TypeError)
  }
})

test('clientIpHeader is lowercased to match Node header keys', () => {
  expect(resolveConfig({ clientIpHeader: 'X-Real-IP' }).clientIpHeader).toBe('x-real-ip')
})

test('an over-long title is rejected', () => {
  expect(resolveConfig({ title: 'a'.repeat(120) })).toBeTruthy()
  expect(bad({ title: 'a'.repeat(121) })).toThrow(/at most 120 characters/)
})

test('boolean settings reject truthy non-booleans', () => {
  for (const key of ['secureCookie', 'trustProxy', 'githubEnabled'] as const) {
    expect(bad({ [key]: 'true' }), `${key} string`).toThrow(TypeError)
    expect(bad({ [key]: 1 }), `${key} number`).toThrow(TypeError)
  }
})

test('numeric settings must be integers', () => {
  expect(bad({ maxSessions: 1.5 })).toThrow(TypeError)
  expect(bad({ maxSessions: '10' })).toThrow(TypeError)
  expect(bad({ maxSessions: Number.NaN })).toThrow(TypeError)
})

test('numeric settings are range-checked at both ends', () => {
  // These bounds decide how much memory an unauthenticated caller can make the
  // process allocate, so zero and negative values must not be accepted.
  const cases: readonly [key: string, tooLow: number, tooHigh: number][] = [
    ['sessionTtlMs', 59_999, 365 * 24 * 60 * 60 * 1000 + 1],
    ['maxBodyBytes', 63, 1024 * 1024 + 1],
    ['maxSessions', 0, 1_000_001],
    ['attemptLimit', 0, 1001],
    ['attemptWindowMs', 999, 24 * 60 * 60 * 1000 + 1],
    ['blockMs', 999, 24 * 60 * 60 * 1000 + 1],
    ['maxAttemptClients', 0, 1_000_001],
    ['sweepIntervalMs', 999, 60 * 60 * 1000 + 1],
    ['githubStateTtlMs', 59_999, 60 * 60 * 1000 + 1],
    ['githubMaxPendingStates', 0, 100_001],
    ['githubRequestTimeoutMs', 999, 60_001],
    ['githubMaxConcurrentCallbacks', 0, 65],
    ['recoveryTtlMs', 59_999, 60 * 60 * 1000 + 1],
  ]
  for (const [key, tooLow, tooHigh] of cases) {
    expect(bad({ [key]: tooLow }), `${key} low`).toThrow(RangeError)
    expect(bad({ [key]: tooHigh }), `${key} high`).toThrow(RangeError)
    expect(bad({ [key]: -1 }), `${key} negative`).toThrow(RangeError)
  }
})

test('valid overrides are carried through', () => {
  const options = resolveConfig({
    title: 'My Shell',
    passwordHashEnv: 'MY_HASH',
    secureCookie: false,
    trustProxy: true,
    maxSessions: 5,
  })
  expect(options.title).toBe('My Shell')
  expect(options.passwordHashEnv).toBe('MY_HASH')
  expect(options.secureCookie).toBe(false)
  expect(options.trustProxy).toBe(true)
  expect(options.maxSessions).toBe(5)
  expect(options.attemptLimit, 'untouched keys keep their default').toBe(DEFAULTS.attemptLimit)
})

test('passwordHashEnv must be a portable environment variable name', () => {
  expect(resolveConfig({ passwordHashEnv: '_HASH_2' })).toBeTruthy()
  for (const value of ['1HASH', 'HASH-NAME', 'HASH NAME', 'HASH\nINJECTED']) {
    expect(bad({ passwordHashEnv: value }), JSON.stringify(value)).toThrow(
      /valid environment variable name/,
    )
  }
})

test('githubEnabled requires a valid publicUrl and keeps secrets in env names', () => {
  expect(bad({ githubEnabled: true })).toThrow(/publicUrl is required/)
  expect(bad({ githubEnabled: true, publicUrl: 'http://example.com' })).toThrow(/https/)
  const options = resolveConfig({
    githubEnabled: true,
    publicUrl: 'https://dsh.example.com/',
  })
  expect(options.publicUrl).toBe('https://dsh.example.com')
  expect(options.githubClientIdEnv).toBe('GITHUB_OAUTH_CLIENT_ID')
  expect(options.githubClientSecretEnv).toBe('GITHUB_OAUTH_CLIENT_SECRET')
})

test('resolvePublicUrl accepts https and loopback http only', () => {
  expect(resolvePublicUrl('https://dsh.example.com')).toBe('https://dsh.example.com')
  expect(resolvePublicUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  expect(resolvePublicUrl('http://localhost:3000')).toBe('http://localhost:3000')
  expect(() => resolvePublicUrl('http://example.com')).toThrow(/https/)
  expect(() => resolvePublicUrl('https://user:pass@example.com')).toThrow(/credentials/)
  expect(() => resolvePublicUrl('https://example.com/path')).toThrow(/origin/)
  expect(() => resolvePublicUrl('https://example.com?x=1')).toThrow(/query/)
})
