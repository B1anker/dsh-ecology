/**
 * Profile composition semantics: the patch YAML dialect (including !!js
 * expressions that must never be evaluated), profile manifests, and
 * dependency-spec classification.
 */

import { describe, expect, test } from '@rstest/core'

import {
  classifySpec,
  parsePatchListText,
  parseProfileManifest,
  summarizePatchEntries,
} from '../../src/domain/composition.js'
import { FileError } from '../../src/domain/errors.js'

describe('parsePatchListText', () => {
  test('parses the entry-list dialect with !!js expressions unevaluated', () => {
    const text = `- id: dsh-web-login
  config:
    secureCookie: false
    exp: !!js require('x').y
- id: pet
  disabled: true
`
    const parsed = parsePatchListText(text, 'cordis.patch.yml')
    expect(parsed).toHaveLength(2)
    const first = parsed[0] as Record<string, unknown>
    const config = first.config as Record<string, unknown>
    expect(config.exp).toEqual({ __jsExpr: "require('x').y" })
  })

  test('rejects a non-array document', () => {
    expect(() => parsePatchListText('plugins:\n  - foo\n', 'x.yml')).toThrow(FileError)
  })

  test('rejects non-mapping entries', () => {
    expect(() => parsePatchListText('- just-a-string\n', 'x.yml')).toThrow(FileError)
  })

  test('rejects malformed YAML with a redacted message', () => {
    expect(() => parsePatchListText('- id: [unclosed\n', 'x.yml')).toThrow(FileError)
  })
})

describe('summarizePatchEntries', () => {
  test('summarises ids, disabled flags, insert names, and redacts config', () => {
    const text = `- id: a
  config:
    apiKey: sk-1234567890
    title: hi
- id: b
  insert:
    - name: ./local-plugin
- disabled-entry:
    disabled: true
`
    const parsed = parsePatchListText(text, 'x.yml')
    const entries = summarizePatchEntries(parsed)
    expect(entries).toHaveLength(3)
    expect(entries[0]?.id).toBe('a')
    expect(entries[0]?.config).toEqual({ apiKey: '<redacted>', title: 'hi' })
    expect(entries[1]?.insertNames).toEqual(['./local-plugin'])
    expect(entries[2]?.id).toBeUndefined()
    expect(entries[2]?.disabled).toBe(false)
    const asJson = JSON.stringify(entries)
    expect(asJson).not.toContain('sk-1234567890')
  })
})

describe('parseProfileManifest', () => {
  test('parses bundles, dependencies, and patchReload', () => {
    const text = JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@seaveyon/dsh-pet': 'link:/tmp/pet' },
      dsh: {
        profile: { bundles: ['@deepseek-ai/dsh-base', '@seaveyon/dsh-pet'], patchReload: 'live' },
      },
    })
    const manifest = parseProfileManifest(text, 'package.json')
    expect(manifest.name).toBe('dsh-profile-web')
    expect(manifest.bundles).toEqual(['@deepseek-ai/dsh-base', '@seaveyon/dsh-pet'])
    expect(manifest.patchReload).toBe('live')
    expect(manifest.dependencies['@seaveyon/dsh-pet']).toBe('link:/tmp/pet')
  })

  test('tolerates a manifest without a dsh section', () => {
    const manifest = parseProfileManifest(JSON.stringify({ name: 'x', private: true }), 'p.json')
    expect(manifest.bundles).toEqual([])
    expect(manifest.dependencies).toEqual({})
  })

  test('rejects invalid JSON and non-object roots', () => {
    expect(() => parseProfileManifest('{oops', 'p.json')).toThrow(FileError)
    expect(() => parseProfileManifest('[]', 'p.json')).toThrow(FileError)
    expect(() => parseProfileManifest('null', 'p.json')).toThrow(FileError)
  })
})

describe('classifySpec', () => {
  test('classifies link, file, git, tarball, registry, and unknown specs', () => {
    expect(classifySpec('link:/abs/pet', '/p').kind).toBe('link')
    expect(classifySpec('file:../pet', '/p').target).toBe('/pet')
    expect(classifySpec('github:B1anker/x', '/p').kind).toBe('git')
    expect(classifySpec('https://x/y.tgz', '/p').kind).toBe('tarball')
    expect(classifySpec('@seaveyon/dsh-pet@^0.1.0', '/p').packageName).toBe('@seaveyon/dsh-pet')
    expect(classifySpec('lodash@4.17.21', '/p').packageName).toBe('lodash')
    expect(classifySpec('=== weird ===', '/p').kind).toBe('unknown')
  })
})
