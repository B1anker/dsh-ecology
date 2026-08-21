/**
 * Turn a client address into the bucket the attempt limiter counts against.
 *
 * Counting per exact address is what an attacker wants. A single residential
 * IPv6 allocation is a /64 — eighteen quintillion addresses — so a limiter keyed
 * on the full address gives one attacker as many independent allowances as it
 * has patience, and fills the limiter's bounded table while doing it. Addresses
 * are therefore masked to the smallest unit an attacker cannot cheaply enumerate
 * before they become a key.
 *
 * The other reason this module exists is that with `trustProxy` enabled the
 * "address" is a request header, which is to say arbitrary attacker-chosen text
 * of arbitrary length. Anything that does not parse as an address collapses into
 * a single bucket rather than becoming a key of its own, so garbage cannot buy
 * an allowance either.
 *
 * @module @seaveyon/dsh-web-login/client-address
 */

/** How wide a bucket is, per address family. */
export interface AddressBucketOptions {
  /** Network bits kept for IPv4. 32 counts each address on its own. */
  ipv4PrefixBits: number
  /** Network bits kept for IPv6. 64 is the usual single-customer allocation. */
  ipv6PrefixBits: number
}

/** Bucket for an address that is absent. */
const UNKNOWN = 'unknown'

/**
 * Bucket for anything that is not an address.
 *
 * One bucket for all of it, deliberately: under `trustProxy` this is
 * attacker-chosen text, and giving each distinct string its own allowance would
 * reproduce the exact problem the masking above exists to solve.
 */
const INVALID = 'invalid'

/**
 * Parse dotted-quad IPv4 into its four octets.
 * @param value - candidate address.
 * @returns the octets, or null when the string is not an IPv4 address.
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    // Explicit digit and leading-zero checks because Number('') is 0, Number(' 1')
    // is 1, and '010' would otherwise be accepted as decimal ten while some
    // resolvers read it as octal eight.
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    octets.push(octet)
  }
  return octets
}

/**
 * Parse a run of colon-separated hex groups.
 * @param run - the groups, possibly an empty string.
 * @returns the parsed groups, or null when any group is malformed.
 */
function hexGroups(run: string): number[] | null {
  if (run === '') return []
  const parsed: number[] = []
  for (const group of run.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    parsed.push(Number.parseInt(group, 16))
  }
  return parsed
}

/**
 * Parse IPv6 into its eight 16-bit groups, expanding `::`.
 *
 * Also accepts the IPv4-mapped tail (`::ffff:192.0.2.1`) that a dual-stack
 * listener produces for every IPv4 client, since that form has to be recognised
 * as IPv4 rather than bucketed as a /64 of one.
 *
 * @param value - candidate address, without a zone identifier.
 * @returns the eight groups, or null when the string is not an IPv6 address.
 */
function parseIpv6(value: string): number[] | null {
  let head = value
  let tail: number[] = []

  const lastColon = head.lastIndexOf(':')
  if (lastColon !== -1 && head.includes('.', lastColon)) {
    const embedded = parseIpv4(head.slice(lastColon + 1))
    if (embedded === null) return null
    tail = [
      ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0),
      ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0),
    ]
    head = head.slice(0, lastColon + 1)
    // The remaining head must still end in a separator, e.g. '::ffff:'.
    if (!head.endsWith(':')) return null
    head = head.slice(0, -1)
  }

  const doubleColon = head.indexOf('::')
  if (doubleColon !== head.lastIndexOf('::')) return null

  let groups: number[]
  if (doubleColon === -1) {
    const parsed = hexGroups(head)
    if (parsed === null) return null
    groups = [...parsed, ...tail]
    if (groups.length !== 8) return null
  } else {
    const left = hexGroups(head.slice(0, doubleColon))
    const right = hexGroups(head.slice(doubleColon + 2))
    if (left === null || right === null) return null
    const explicit = left.length + right.length + tail.length
    if (explicit > 7) return null
    const elided = Array.from<number>({ length: 8 - explicit }).fill(0)
    groups = [...left, ...elided, ...right, ...tail]
  }
  return groups
}

/**
 * Mask the low bits of a group.
 * @param group - the value to mask.
 * @param width - the group's width in bits.
 * @param keep - how many leading bits to keep.
 * @returns the masked value.
 */
function maskGroup(group: number, width: number, keep: number): number {
  if (keep >= width) return group
  if (keep <= 0) return 0
  return (group >>> (width - keep)) << (width - keep)
}

/**
 * Map a client address to its limiter bucket.
 *
 * The returned string is a key, not a display value, but it is written to be
 * readable: a warning line naming `2001:db8:0:1::/64` tells an operator far more
 * than an opaque digest would, and there is nothing secret in it.
 *
 * @param address - the socket address or forwarded header value; may be absent.
 * @param options - how wide a bucket to use for each family.
 * @returns a stable bucket key.
 */
export function bucketAddress(address: unknown, options: AddressBucketOptions): string {
  if (typeof address !== 'string' || address === '') return UNKNOWN

  // A link-local address carries a zone ('fe80::1%eth0'). The zone identifies an
  // interface on this host, not a network, so it cannot distinguish clients.
  const bare = address.split('%')[0] ?? ''

  const v4 = parseIpv4(bare)
  if (v4 !== null) {
    const bits = options.ipv4PrefixBits
    const masked = v4.map((octet, index) => maskGroup(octet, 8, bits - index * 8))
    return `${masked.join('.')}/${bits}`
  }

  const v6 = parseIpv6(bare)
  if (v6 === null) return INVALID

  // A dual-stack listener reports every IPv4 client as ::ffff:a.b.c.d. Bucketing
  // those as IPv6 would apply a /64 to what is really one IPv4 address, merging
  // unrelated clients into a single allowance.
  const mappedV4 =
    v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff
  if (mappedV4) {
    const high = v6[6] ?? 0
    const low = v6[7] ?? 0
    return bucketAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`, options)
  }

  const bits = options.ipv6PrefixBits
  const masked = v6.map((group, index) => maskGroup(group, 16, bits - index * 16))
  return `${masked.map((group) => group.toString(16).padStart(4, '0')).join(':')}/${bits}`
}
