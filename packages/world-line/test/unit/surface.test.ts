/**
 * Package surface (src/index.ts) and human rendering of timeline results —
 * the two paths JSON envelopes do not exercise.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import {
  ENVELOPE_SCHEMA_VERSION,
  main,
  runCli,
  WlError,
  WORLD_LINE_FORMAT_VERSION,
  WORLD_LINE_VERSION,
} from '../../src/index.js'
import { makeTempHome, profilePackageJson, runCliIn, writeProfile } from '../helpers/fixture.js'

describe('package surface', () => {
  test('index re-exports the identity and runner', () => {
    expect(WORLD_LINE_VERSION).toBe('0.1.0')
    expect(ENVELOPE_SCHEMA_VERSION).toBe(1)
    expect(WORLD_LINE_FORMAT_VERSION).toBe(1)
    expect(typeof runCli).toBe('function')
    expect(typeof main).toBe('function')
    expect(typeof WlError).toBe('function')
  })
})

describe('human timeline renders', () => {
  test('list, show, and diff render legibly without JSON', async () => {
    const home = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      const first = await runCliIn({ argv: ['snapshot', 'create', '--label', 'first'], home })
      expect(first.exitCode).toBe(0)
      const firstId = /snap-[0-9A-Za-z-]+/.exec(first.stdout)?.[0]
      expect(firstId).toBeDefined()

      const dir = join(home, 'profiles', 'web')
      await writeFile(join(dir, 'cordis.patch.yml'), '- id: gate\n  config:\n    enabled: false\n')
      await writeFile(
        join(dir, 'package.json'),
        profilePackageJson({ bundles: ['@deepseek-ai/dsh-base'] }),
      )
      const second = await runCliIn({ argv: ['snapshot', 'create', '--label', 'second'], home })
      expect(second.exitCode).toBe(0)
      const secondId = /snap-[0-9A-Za-z-]+/.exec(second.stdout)?.[0]
      expect(secondId).toBeDefined()

      const list = await runCliIn({ argv: ['timeline', 'list'], home })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain('first')
      expect(list.stdout).toContain('second')
      expect(list.stdout).toContain('deps')

      const show = await runCliIn({ argv: ['timeline', 'show', secondId ?? ''], home })
      expect(show.exitCode).toBe(0)
      expect(show.stdout).toContain('cordis.patch.yml')
      expect(show.stdout).toContain('receipt')
      expect(show.stdout).toContain(firstId ?? 'snap-')

      const diff = await runCliIn({
        argv: ['timeline', 'diff', firstId ?? '', secondId ?? ''],
        home,
      })
      expect(diff.exitCode).toBe(0)
      expect(diff.stdout).toContain('cordis.patch.yml')
      expect(diff.stdout).toContain('bundles')

      // timeline show without any snapshot id resolves to the latest.
      const latest = await runCliIn({ argv: ['timeline', 'show'], home })
      expect(latest.exitCode).toBe(0)
      expect(latest.stdout).toContain('second')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('empty timeline lists carry guidance', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wl-empty-'))
    try {
      await writeProfile(home, 'web')
      const list = await runCliIn({ argv: ['timeline', 'list'], home })
      expect(list.exitCode).toBe(0)
      expect(list.stdout).toContain('snapshot create')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
