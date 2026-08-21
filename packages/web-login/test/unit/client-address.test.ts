import { expect, test } from '@rstest/core'
import { type AddressBucketOptions, bucketAddress } from '../../src/client-address.js'

const DEFAULTS: AddressBucketOptions = { ipv4PrefixBits: 32, ipv6PrefixBits: 64 }

/**
 * Bucket an address with the package defaults.
 * @param address - the address to bucket.
 * @param overrides - prefix widths to change.
 * @returns the bucket key.
 */
function bucket(address: unknown, overrides: Partial<AddressBucketOptions> = {}): string {
  return bucketAddress(address, { ...DEFAULTS, ...overrides })
}

test('an IPv4 address keeps its own bucket by default', () => {
  expect(bucket('203.0.113.5')).toBe('203.0.113.5/32')
  expect(bucket('203.0.113.6')).not.toBe(bucket('203.0.113.5'))
})

test('IPv4 can be aggregated to a network', () => {
  expect(bucket('203.0.113.5', { ipv4PrefixBits: 24 })).toBe('203.0.113.0/24')
  expect(bucket('203.0.113.200', { ipv4PrefixBits: 24 })).toBe('203.0.113.0/24')
  expect(bucket('203.0.114.1', { ipv4PrefixBits: 24 })).toBe('203.0.114.0/24')
  expect(bucket('203.0.113.5', { ipv4PrefixBits: 8 })).toBe('203.0.0.0/8')
})

test('a prefix that does not fall on a group boundary masks within the group', () => {
  // Where masking bugs live. A /24 or a /64 can be implemented by dropping
  // whole octets or whole groups and still look correct; a /20 or a /60 cannot.
  expect(bucket('203.0.119.5', { ipv4PrefixBits: 20 })).toBe('203.0.112.0/20')
  expect(bucket('203.0.127.9', { ipv4PrefixBits: 20 })).toBe('203.0.112.0/20')
  expect(bucket('203.0.128.1', { ipv4PrefixBits: 20 })).not.toBe('203.0.112.0/20')

  expect(bucket('2001:db8:abcd:123f::1', { ipv6PrefixBits: 60 })).toBe(
    '2001:0db8:abcd:1230:0000:0000:0000:0000/60',
  )
  expect(bucket('2001:db8:abcd:1230::9', { ipv6PrefixBits: 60 })).toBe(
    bucket('2001:db8:abcd:123f::1', { ipv6PrefixBits: 60 }),
  )
})

test('IPv6 is aggregated to the allocation, not the address', () => {
  const one = bucket('2001:db8:abcd:1234:1:2:3:4')
  const another = bucket('2001:db8:abcd:1234::ffff')
  expect(one).toBe(another)
  expect(one).toBe('2001:0db8:abcd:1234:0000:0000:0000:0000/64')
  expect(bucket('2001:db8:abcd:1235::1')).not.toBe(one)
})

test('the compressed, uppercase, and full IPv6 forms agree', () => {
  const expanded = bucket('2001:0db8:0000:0000:0000:0000:0000:0001', { ipv6PrefixBits: 128 })
  expect(bucket('2001:db8::1', { ipv6PrefixBits: 128 })).toBe(expanded)
  expect(bucket('2001:DB8::1', { ipv6PrefixBits: 128 })).toBe(expanded)
})

test('an IPv4-mapped address is treated as the IPv4 address it is', () => {
  // Every IPv4 client of a dual-stack listener arrives in this form. Bucketing
  // it as IPv6 would apply a /64 to what is really one address, merging
  // unrelated clients into a single allowance.
  expect(bucket('::ffff:203.0.113.5')).toBe('203.0.113.5/32')
  expect(bucket('::ffff:203.0.113.5', { ipv4PrefixBits: 24 })).toBe('203.0.113.0/24')
  expect(bucket('::ffff:203.0.113.5')).toBe(bucket('203.0.113.5'))
})

test('a zone identifier does not distinguish clients', () => {
  // The zone names an interface on this host, so two clients reached through
  // the same one are not thereby different clients.
  expect(bucket('fe80::1%eth0', { ipv6PrefixBits: 128 })).toBe(
    bucket('fe80::1', { ipv6PrefixBits: 128 }),
  )
})

test('the loopback addresses bucket predictably', () => {
  expect(bucket('127.0.0.1')).toBe('127.0.0.1/32')
  expect(bucket('::1', { ipv6PrefixBits: 128 })).toBe('0000:0000:0000:0000:0000:0000:0000:0001/128')
})

test('an absent address is its own bucket', () => {
  for (const address of [undefined, null, '', 42, {}]) {
    expect(bucketAddress(address, DEFAULTS), JSON.stringify(address)).toBe('unknown')
  }
})

test('everything that is not an address shares one bucket', () => {
  // With trustProxy enabled this input is an attacker-chosen header value, so
  // each distinct string must not become a distinct allowance.
  const garbage = [
    'not-an-ip',
    '203.0.113',
    '203.0.113.5.6',
    '256.0.0.1',
    '010.0.0.1',
    '1.2.3.-1',
    ' 1.2.3.4',
    '2001:db8::1::2',
    '2001:db8:zzzz::1',
    '12345::1',
    'x'.repeat(10_000),
  ]
  for (const value of garbage) {
    expect(bucketAddress(value, DEFAULTS), value.slice(0, 30)).toBe('invalid')
  }
})

test('a bucket key is bounded no matter how long the input was', () => {
  const key = bucketAddress('x'.repeat(100_000), DEFAULTS)
  // The key becomes a map key in the attempt limiter, so an unbounded input
  // must not become unbounded retained memory.
  expect(key.length).toBeLessThan(64)
})
