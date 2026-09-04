/**
 * Encrypted vault unit tests: AES-256-GCM round trips, tamper detection,
 * the safe-skip contract of the key providers, and the Keychain adapter
 * exercised against a fake `security` binary (never the real keychain).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { sha256Hex } from '../../src/fs/hash.js'
import {
  decryptChunk,
  decryptSecretBundle,
  encryptChunk,
  fakeSecurityKeyProvider,
  keychainKeyProvider,
  MemoryKeyProvider,
  SECRET_CIPHER,
  type SecretBundleHeader,
  serializeSecretBundle,
  splitSecretBundle,
} from '../../src/vault/crypto.js'

const KEY = Buffer.from('00'.repeat(32), 'hex')

describe('AES-256-GCM secret chunks', () => {
  test('encrypt then decrypt round-trips the plaintext', () => {
    const plaintext = Buffer.from('dsh token=sekret value\nsecond line\n')
    const { iv, tag, ciphertext } = encryptChunk(KEY, plaintext)
    expect(ciphertext.equals(plaintext)).toBe(false)
    expect(iv.byteLength).toBe(12)
    expect(tag.byteLength).toBe(16)
    const back = decryptChunk(KEY, iv, tag, ciphertext)
    expect(back.toString('utf8')).toBe(plaintext.toString('utf8'))
  })

  test('a wrong key fails to decrypt (never silent plaintext)', () => {
    const { iv, tag, ciphertext } = encryptChunk(KEY, Buffer.from('secret'))
    const wrong = Buffer.from('11'.repeat(32), 'hex')
    expect(() => decryptChunk(wrong, iv, tag, ciphertext)).toThrow()
  })

  test('tampered ciphertext is rejected by the auth tag', () => {
    const { iv, tag, ciphertext } = encryptChunk(KEY, Buffer.from('secret'))
    ciphertext[0] = ciphertext[0]! ^ 0xff
    expect(() => decryptChunk(KEY, iv, tag, ciphertext)).toThrow()
  })
})

describe('secret bundle envelope', () => {
  test('serialize/decrypt round-trips several files', () => {
    const a = Buffer.from('token=abc')
    const b = Buffer.from('client-secret=xyz\nmore')
    const entries: Array<{ name: string; plaintext: Buffer }> = [
      { name: 'package.json', plaintext: a },
      { name: 'cordis.patch.yml', plaintext: b },
    ]
    const header: SecretBundleHeader = {
      formatVersion: 1,
      algorithm: SECRET_CIPHER,
      createdAt: '2026-09-04T00:00:00.000Z',
      files: [],
    }
    const ciphertexts: Buffer[] = []
    for (const entry of entries) {
      const { iv, tag, ciphertext } = encryptChunk(KEY, entry.plaintext)
      header.files.push({
        name: entry.name,
        size: ciphertext.byteLength,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
      })
      ciphertexts.push(ciphertext)
    }
    const bundle = serializeSecretBundle(header, ciphertexts)
    const back = decryptSecretBundle(KEY, bundle)
    expect(back.map((entry) => entry.name)).toEqual(['package.json', 'cordis.patch.yml'])
    expect(back[0]!.plaintext.equals(a)).toBe(true)
    expect(back[1]!.plaintext.equals(b)).toBe(true)
    expect(sha256Hex(bundle)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a truncated bundle throws instead of returning partial secrets', () => {
    const entry = encryptChunk(KEY, Buffer.from('secret-content'))
    const header: SecretBundleHeader = {
      formatVersion: 1,
      algorithm: SECRET_CIPHER,
      createdAt: '2026-09-04T00:00:00.000Z',
      files: [
        {
          name: 'cordis.patch.yml',
          size: 9999,
          iv: entry.iv.toString('hex'),
          tag: entry.tag.toString('hex'),
        },
      ],
    }
    const bundle = serializeSecretBundle(header, [entry.ciphertext])
    expect(() => decryptSecretBundle(KEY, bundle)).toThrow(/truncated/)
  })

  test('splitSecretBundle rejects unsupported envelopes', () => {
    const bogus = Buffer.from('{"formatVersion":9,"algorithm":"aes-128-cbc","files":[]}\n')
    expect(() => splitSecretBundle(bogus)).toThrow(/not a supported/)
  })
})

describe('key providers', () => {
  test('memory provider returns null until a key is set (safe-skip contract)', async () => {
    const provider = new MemoryKeyProvider()
    expect(await provider.getOrCreateKey()).toBeNull()
    provider.setKey(KEY)
    expect((await provider.getOrCreateKey())?.equals(KEY)).toBe(true)
  })

  test('keychain provider with a broken binary degrades to null, never throws', async () => {
    const provider = keychainKeyProvider({
      binary: '/nonexistent/security-kl',
      account: 'unit-test-broken',
    })
    expect(await provider.getOrCreateKey()).toBeNull()
  })

  test('fake security binary: find miss then add stores the key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-secret-fake-'))
    const bin = join(dir, 'security')
    await writeFile(
      bin,
      `#!/usr/bin/env bash
set -eu
op="$1"
if [ "$op" = "find-generic-password" ]; then
  exit 44
fi
if [ "$op" = "add-generic-password" ]; then
  printf 'added\n'
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    )
    try {
      const key = Buffer.from('ab'.repeat(32), 'hex')
      const provider = fakeSecurityKeyProvider(key, bin)
      const got = await provider.getOrCreateKey()
      expect(got?.equals(key)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('fake security binary: existing key is found and reused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-secret-fake2-'))
    const bin = join(dir, 'security')
    const key = Buffer.from('cd'.repeat(32), 'hex')
    await writeFile(
      bin,
      `#!/usr/bin/env bash
set -eu
op="$1"
if [ "$op" = "find-generic-password" ]; then
  printf '${key.toString('hex')}\\n'
  exit 0
fi
exit 99
`,
      { mode: 0o755 },
    )
    try {
      const provider = keychainKeyProvider({ binary: bin, account: 'unit-test-find' })
      const got = await provider.getOrCreateKey()
      expect(got?.equals(key)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('keychain output that is not 64 hex chars is treated as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wl-secret-fake3-'))
    const bin = join(dir, 'security')
    await writeFile(
      bin,
      `#!/usr/bin/env bash
printf 'not-a-hex-key\\n'
exit 0
`,
      { mode: 0o755 },
    )
    try {
      const provider = keychainKeyProvider({ binary: bin, account: 'unit-test-bad' })
      const got = await provider.getOrCreateKey()
      // find returned garbage → key invalid → no key service answer.
      expect(got).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
