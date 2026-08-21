/**
 * Property tests for the parsers on the unauthenticated path.
 *
 * Every function exercised here reads a string an unauthenticated caller chose:
 * a Cookie header, a forwarded-address header, an environment value, a stored
 * verifier. The example-based suites next to this one check the cases someone
 * thought of. These check the ones nobody did, and they check the invariant
 * rather than the output — that the function is total, that a value survives a
 * round trip, that widening a network never splits a bucket — because those are
 * the properties the calling code actually relies on.
 */

import { expect, test } from '@rstest/core'
import * as fc from 'fast-check'
import { type AddressBucketOptions, bucketAddress } from '../../src/client-address.js'
import { readCookie, serializeSessionCookie, sessionCookieName } from '../../src/cookies.js'
import { isEnvName, upsertEnvAssignment } from '../../src/env-file.js'
import { clientKey } from '../../src/http.js'
import { parseVerifier } from '../../src/verifier.js'

/** Characters a cookie name may contain, per the RFC 6265 token rule. */
const COOKIE_NAME = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/)

/** Anything at all, including the shapes a header map can actually produce. */
const ANY_HEADER_VALUE = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.constantFrom('', ' ', ';', '=', '%', '%E0%A4%A', '\u0000', '\r\n'),
)

/** Lowercase hex of exactly `bytes` bytes, the form a verifier stores. */
const hex = (bytes: number): fc.Arbitrary<string> =>
  fc.stringMatching(new RegExp(`^[0-9a-f]{${bytes * 2}}$`))

/** A dotted-quad IPv4 address. */
const OCTET = fc.integer({ min: 0, max: 255 })
const IPV4 = fc.tuple(OCTET, OCTET, OCTET, OCTET).map((parts) => parts.join('.'))

/** A fully-written eight-group IPv6 address. */
const GROUP = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16))
const IPV6 = fc.array(GROUP, { minLength: 8, maxLength: 8 }).map((parts) => parts.join(':'))

/** An environment variable name `upsertEnvAssignment` will accept. */
const ENV_NAME = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}$/).filter(isEnvName)

/** A single line: anything a `.env` file can hold on one row. */
const ENV_LINE = fc.string().filter((s) => !s.includes('\n') && !s.includes('\r'))

/** Zero or more lines joined as file contents. */
const ENV_FILE = fc.array(ENV_LINE, { maxLength: 8 }).map((lines) => lines.join('\n'))

/**
 * Bucket an address at one IPv4 width.
 * @param address - the address to bucket.
 * @param bits - the IPv4 prefix width.
 * @returns the bucket key.
 */
function atV4(address: string, bits: number): string {
  return bucketAddress(address, { ipv4PrefixBits: bits, ipv6PrefixBits: 64 })
}

/**
 * Bucket an address at one IPv6 width.
 * @param address - the address to bucket.
 * @param bits - the IPv6 prefix width.
 * @returns the bucket key.
 */
function atV6(address: string, bits: number): string {
  return bucketAddress(address, { ipv4PrefixBits: 32, ipv6PrefixBits: bits })
}

/**
 * Build a request stub carrying the given header and peer address.
 * @param headers - the header map to expose.
 * @param remoteAddress - the socket peer, if any.
 * @returns an object shaped like the part of IncomingMessage clientKey reads.
 */
function requestWith(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): Parameters<typeof clientKey>[0] {
  return { headers, socket: { remoteAddress } } as unknown as Parameters<typeof clientKey>[0]
}

test('parseVerifier answers for every input instead of throwing', () => {
  // It runs at startup on an operator-supplied environment variable. A throw
  // here would surface as a stack trace instead of the message that says which
  // variable is wrong and how to regenerate it.
  fc.assert(
    fc.property(fc.anything(), (value) => {
      expect(() => parseVerifier(value)).not.toThrow()
    }),
  )
})

test('parseVerifier accepts a string only in the exact stored form', () => {
  fc.assert(
    fc.property(hex(16), hex(64), (salt, key) => {
      const parsed = parseVerifier(`scrypt$${salt}$${key}`)
      expect(parsed).not.toBeNull()
      // The lengths are the point: Buffer.from(_, 'hex') truncates at the first
      // bad pair, so a parser that only checked the alphabet would turn a
      // corrupted verifier into a shorter, weaker one that still compares.
      expect(parsed?.salt.length).toBe(16)
      expect(parsed?.expected.length).toBe(64)
    }),
  )

  fc.assert(
    fc.property(hex(16), hex(64), (salt, key) => {
      const mutations = [
        `scrypt$${salt}$${key} `,
        `scrypt$${salt.toUpperCase()}$${key}`,
        `scrypt$${salt}$${key}$`,
        `scrypt$${salt.slice(1)}$${key}`,
        `scrypt$${salt}$${key}0`,
        `Scrypt$${salt}$${key}`,
        `${salt}$${key}`,
      ]
      for (const mutated of mutations) expect(parseVerifier(mutated), mutated).toBeNull()
    }),
  )
})

test('readCookie answers for every header instead of throwing', () => {
  // A hostile cookie has to be indistinguishable from no cookie. If a stray `%`
  // could make decodeURIComponent throw out of here, any caller could take down
  // the request that carried it.
  fc.assert(
    fc.property(fc.anything(), COOKIE_NAME, (header, name) => {
      expect(() => readCookie(header, name)).not.toThrow()
    }),
  )
})

test('a cookie value survives the round trip through a header', () => {
  fc.assert(
    fc.property(COOKIE_NAME, fc.string(), (name, value) => {
      const header = `${name}=${encodeURIComponent(value)}`
      expect(readCookie(header, name)).toBe(value)
    }),
  )
})

test('a cookie is found among unrelated ones and only under its own name', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(COOKIE_NAME, { minLength: 2, maxLength: 6 }),
      fc.array(fc.string(), { minLength: 6, maxLength: 6 }),
      (names, values) => {
        const wanted = names[0] as string
        const header = names
          .map((name, index) => `${name}=${encodeURIComponent(values[index] ?? '')}`)
          .join('; ')
        expect(readCookie(header, wanted)).toBe(values[0] ?? '')
        // Prefix and suffix confusion: `dsh_session` must not be read out of
        // `x_dsh_session` or `dsh_session_backup`.
        expect(readCookie(header, `x${wanted}`)).toBeUndefined()
        expect(readCookie(header, `${wanted}x`)).toBeUndefined()
      },
    ),
  )
})

test('a duplicated name is refused whenever the values disagree', () => {
  fc.assert(
    fc.property(COOKIE_NAME, fc.string(), fc.string(), (name, first, second) => {
      const header = `${name}=${encodeURIComponent(first)}; ${name}=${encodeURIComponent(second)}`
      // Same value twice is one cookie the browser repeated. Different values
      // are two cookies, and nothing in the header says which one is ours.
      expect(readCookie(header, name)).toBe(first === second ? first : undefined)
    }),
  )
})

test('a session cookie reads back out of the header it serializes into', () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[0-9a-f]{1,64}$/), fc.boolean(), (id, secure) => {
      const setCookie = serializeSessionCookie(id, { maxAgeSeconds: 3600, secure })
      const header = setCookie.split(';')[0] as string
      expect(readCookie(header, sessionCookieName(secure))).toBe(id)
    }),
  )
})

test('bucketAddress answers for every input instead of throwing', () => {
  const widths = fc.integer({ min: 0, max: 32 })
  fc.assert(
    fc.property(fc.anything(), widths, fc.integer({ min: 0, max: 128 }), (value, v4, v6) => {
      expect(() => bucketAddress(value, { ipv4PrefixBits: v4, ipv6PrefixBits: v6 })).not.toThrow()
    }),
  )
})

test('a bucket key stays short however long the input was', () => {
  // The key is retained as a Map key in the attempt limiter. An input-sized key
  // would make an unbounded header into unbounded resident memory.
  fc.assert(
    fc.property(ANY_HEADER_VALUE, (value) => {
      const key = bucketAddress(value, { ipv4PrefixBits: 32, ipv6PrefixBits: 64 })
      expect(key.length).toBeLessThanOrEqual(43)
    }),
  )
})

test('widening the network never separates two addresses that shared one', () => {
  // The whole point of bucketing is that an attacker cannot escape a limit by
  // moving within their allocation. That only holds if the mask is monotone: if
  // a /28 puts two addresses together, every wider prefix must too.
  fc.assert(
    fc.property(
      IPV4,
      IPV4,
      fc.integer({ min: 0, max: 32 }),
      fc.integer({ min: 0, max: 32 }),
      (a, b, x, y) => {
        const [narrow, wide] = x >= y ? [x, y] : [y, x]
        if (atV4(a, narrow) !== atV4(b, narrow)) return
        expect(atV4(a, wide)).toBe(atV4(b, wide))
      },
    ),
  )

  fc.assert(
    fc.property(
      IPV6,
      IPV6,
      fc.integer({ min: 0, max: 128 }),
      fc.integer({ min: 0, max: 128 }),
      (a, b, x, y) => {
        const [narrow, wide] = x >= y ? [x, y] : [y, x]
        if (atV6(a, narrow) !== atV6(b, narrow)) return
        expect(atV6(a, wide)).toBe(atV6(b, wide))
      },
    ),
  )
})

test('bucketing a bucket representative lands on the same bucket', () => {
  fc.assert(
    fc.property(IPV4, fc.integer({ min: 0, max: 32 }), (address, bits) => {
      const options: AddressBucketOptions = { ipv4PrefixBits: bits, ipv6PrefixBits: 64 }
      const key = bucketAddress(address, options)
      const representative = key.slice(0, key.lastIndexOf('/'))
      expect(bucketAddress(representative, options)).toBe(key)
    }),
  )
})

test('a forwarded header can never widen a client past one bucket', () => {
  // With trustProxy on, this header is attacker-chosen. Every distinct value it
  // can take must land on either a real network bucket or one of the two
  // sentinels — never on a value-derived key, which would hand the caller an
  // unlimited supply of fresh allowances.
  fc.assert(
    fc.property(ANY_HEADER_VALUE, (forwarded) => {
      const key = clientKey(requestWith({ 'x-forwarded-for': forwarded }, '203.0.113.9'), {
        trustProxy: true,
        clientIpHeader: 'x-forwarded-for',
        ipv4PrefixBits: 32,
        ipv6PrefixBits: 64,
      })
      expect(key.length).toBeLessThanOrEqual(43)
      expect(key.includes('\n')).toBe(false)
    }),
  )
})

test('the forwarded header is ignored entirely unless the proxy is trusted', () => {
  fc.assert(
    fc.property(ANY_HEADER_VALUE, (forwarded) => {
      const key = clientKey(requestWith({ 'x-forwarded-for': forwarded }, '203.0.113.9'), {
        trustProxy: false,
        clientIpHeader: 'x-forwarded-for',
        ipv4PrefixBits: 32,
        ipv6PrefixBits: 64,
      })
      expect(key).toBe('203.0.113.9/32')
    }),
  )
})

test('upsertEnvAssignment leaves a file with exactly one assignment of the key', () => {
  fc.assert(
    fc.property(ENV_FILE, ENV_NAME, ENV_LINE, (before, name, value) => {
      const after = upsertEnvAssignment(before, name, value)
      expect(after.endsWith('\n')).toBe(true)
      const assignments = after.split('\n').filter((l) => l.startsWith(`${name}=`))
      expect(assignments).toEqual([`${name}=${value}`])
    }),
  )
})

test('upsertEnvAssignment is idempotent and last-write-wins', () => {
  fc.assert(
    fc.property(ENV_FILE, ENV_NAME, ENV_LINE, ENV_LINE, (before, name, first, second) => {
      const once = upsertEnvAssignment(before, name, first)
      // Rotating a password re-runs this against a file the last run wrote. If
      // it were not idempotent the file would grow a line every time.
      expect(upsertEnvAssignment(once, name, first)).toBe(once)
      expect(upsertEnvAssignment(once, name, second)).toBe(
        upsertEnvAssignment(before, name, second),
      )
    }),
  )
})

test('upsertEnvAssignment keeps every unrelated line in order', () => {
  // The file holds unrelated dsh settings. Losing one is a dsh that starts with
  // different behaviour and no indication why.
  fc.assert(
    fc.property(fc.array(ENV_LINE, { maxLength: 8 }), ENV_NAME, ENV_LINE, (lines, name, value) => {
      const before = lines.join('\n')
      const after = upsertEnvAssignment(before, name, value)
      const survivors = after.split('\n').slice(0, -2)
      const unrelated = lines.filter((l) => !l.startsWith(`${name}=`))
      while (unrelated.length > 0 && unrelated[unrelated.length - 1]?.trim() === '') unrelated.pop()
      expect(survivors).toEqual(unrelated)
    }),
  )
})

test('upsertEnvAssignment refuses a value that would forge a second line', () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const injects = value.includes('\n') || value.includes('\r')
      const attempt = (): string => upsertEnvAssignment('', 'DSH_WEB_LOGIN_VERIFIER', value)
      if (injects) expect(attempt).toThrow(TypeError)
      else expect(attempt).not.toThrow()
    }),
  )
})
