/**
 * Phase 2 core module tests: probe records/summaries, lab layout/id rules,
 * manifest read/write + the §5 state machine, and compose static analysis
 * (duplicates, invalid patch rows, missing packages, inject-external cycles)
 * plus the compose probe with an injectable fake runner.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import { InvariantError, UsageError } from '../../src/domain/errors.js'
import {
  COMPOSE_CHECK,
  HOST_BOOT_CHECK,
  HTTP_READY_CHECK,
  probe,
  summarizeProbes,
} from '../../src/domain/probe.js'
import {
  findCompositionProblems,
  parseComposedTreeText,
  runComposeProbe,
} from '../../src/lab/compose.js'
import {
  assertValidLabId,
  labDir,
  labExists,
  labRoot,
  listLabs,
  newLabId,
} from '../../src/lab/layout.js'
import type { LabManifest } from '../../src/lab/manifest.js'
import {
  isApplying,
  labManifestOf,
  readLabManifest,
  transitionState,
  writeLabManifest,
} from '../../src/lab/manifest.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

function fixtureManifest(id: string): LabManifest {
  return {
    manifestVersion: 1,
    id,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    adapterId: 'dsh-0.1.x',
    dshVersion: '0.1.2-rc.1',
    runtime: { nodeVersion: 'v24.0.0', os: 'test os', arch: 'test arch' },
    source: { profileName: 'web', receipt: '0000000000000000000000000000000000000000' },
    state: 'created',
    runCount: 0,
    plan: [],
    retention: { cleanupMode: 'keep-on-failure' },
  }
}

describe('probe records and summaries', () => {
  test('records one finished probe with redacted shape', () => {
    const now = new Date('2026-09-04T00:00:00.000Z')
    const result = probe(now, COMPOSE_CHECK, 'compose ok', 'pass', { detail: 'fine' })
    expect(result.check).toBe(COMPOSE_CHECK)
    expect(result.startedAt).toBe(now.toISOString())
    expect(result.finishedAt).toBe(now.toISOString())
    expect(result.required).toBe(true)
    const warn = probe(now, HOST_BOOT_CHECK, 'host boot', 'warn', { detail: 'x' })
    expect(warn.required).toBe(false)
    const skip = probe(now, HTTP_READY_CHECK, 'http ready', 'skip')
    expect(skip.required).toBe(false)
  })

  test('summarizes: failures and inconclusive results fail the run', () => {
    const now = new Date('2026-09-04T00:00:00.000Z')
    const allGood = summarizeProbes([
      probe(now, COMPOSE_CHECK, 'a', 'pass'),
      probe(now, HOST_BOOT_CHECK, 'b', 'pass'),
    ])
    expect(allGood.ok).toBe(true)
    expect(allGood.passed).toBe(2)
    const mixed = summarizeProbes([
      probe(now, COMPOSE_CHECK, 'a', 'fail', { detail: 'boom' }),
      probe(now, HOST_BOOT_CHECK, 'b', 'pass'),
      probe(now, HTTP_READY_CHECK, 'c', 'inconclusive'),
      probe(now, COMPOSE_CHECK, 'd', 'warn', { detail: 'note' }),
    ])
    expect(mixed.ok).toBe(false)
    expect(mixed.failed).toBe(1)
    expect(mixed.inconclusive).toBe(1)
    expect(mixed.warned).toBe(1)
  })
})

describe('lab layout', () => {
  test('new ids match the lexicographic shape and validation', () => {
    const now = new Date('2026-09-04T12:30:45.000Z')
    const id = newLabId(now)
    expect(id).toMatch(/^lab-20260904T123045Z-[0-9a-f]{8}$/)
    expect(id > 'lab-20260904T123044Z-00000000').toBe(true)
    expect(() => assertValidLabId(id)).not.toThrow()
    expect(() => assertValidLabId('lab-nope')).toThrow(UsageError)
    expect(() => assertValidLabId('20260904T123045Z-abcdef12')).toThrow(UsageError)
  })

  test('lab dirs stay under home/world-line/labs and list newest first', async () => {
    const home = await makeTempHome()
    try {
      const dir = labRoot(home)
      expect(dir.endsWith('/world-line/labs')).toBe(true)
      const a = newLabId(new Date('2026-09-04T10:00:00.000Z'))
      const b = newLabId(new Date('2026-09-05T10:00:00.000Z'))
      const c = newLabId(new Date('2026-09-06T10:00:00.000Z'))
      const { mkdir } = await import('node:fs/promises')
      await mkdir(labDir(home, a), { recursive: true })
      await mkdir(labDir(home, b), { recursive: true })
      await mkdir(labDir(home, c), { recursive: true })
      await mkdir(join(labDir(home, a), 'junk-not-a-lab'), { recursive: true })
      expect(await listLabs(home)).toEqual([c, b, a])
      expect(await labExists(home, a)).toBe(true)
      expect(await labExists(home, 'lab-20000101T000000Z-00000000')).toBe(false)
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('lab manifest', () => {
  test('state machine allows legal moves only', () => {
    const now = new Date('2026-09-04T00:00:00.000Z')
    let manifest = fixtureManifest('lab-20260904T000000Z-12345678')
    expect(isApplying(manifest)).toBe(false) // created may start its first run
    manifest = transitionState(manifest, 'applying', now)
    expect(isApplying(manifest)).toBe(true)
    manifest = transitionState(manifest, 'passed', now)
    expect(isApplying(manifest)).toBe(false)
    expect(() => transitionState(manifest, 'applying', now)).not.toThrow()
    manifest = transitionState(manifest, 'destroyed', now)
    expect(manifest.state).toBe('destroyed')
    expect(() => transitionState(manifest, 'applying', now)).toThrow(InvariantError)
    expect(() => transitionState(manifest, 'destroyed', now)).toThrow(InvariantError)
  })

  test('parse and atomic write round-trip', async () => {
    const home = await makeTempHome()
    try {
      const manifest = fixtureManifest('lab-20260904T000000Z-abcdef01')
      await writeLabManifest(home, manifest, new Date('2026-09-04T01:00:00.000Z'))
      const text = await readFile(join(labDir(home, manifest.id), 'manifest.json'), 'utf8')
      expect(text).toContain('"state": "created"')
      expect(text.endsWith('\n')).toBe(true)
      const parsed = labManifestOf(JSON.parse(text), manifest.id)
      expect(parsed.updatedAt).toBe('2026-09-04T01:00:00.000Z')
      const reread = await readLabManifest(home, manifest.id)
      expect(reread.id).toBe(manifest.id)
      expect(reread.source.profileName).toBe('web')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('rejects corrupt and unsupported manifests', async () => {
    const home = await makeTempHome()
    try {
      const id = 'lab-20260904T000000Z-abcdef02'
      const dir = labDir(home, id)
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'manifest.json'), 'not json', 'utf8')
      await expect(readLabManifest(home, id)).rejects.toThrow(/not valid JSON/)
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ manifestVersion: 99 }), 'utf8')
      await expect(readLabManifest(home, id)).rejects.toThrow(/unsupported manifestVersion/)
    } finally {
      await destroyTempHome(home)
    }
  })
})

const DUP_TREE = `# == a
- id: svc
  name: alpha
# == b
- id: svc
  name: beta
`
const CLEAN_TREE = `- id: alpha
  name: '@x/alpha'
- id: beta
  name: '@x/beta'
- id: alpha-http
  name: alpha-http
  inject:
    external: true
    target: alpha
`
const SELF_CYCLE_TREE = `- id: loop
  name: loop
  inject:
    external: true
    id: loop
`
const CHAIN_CYCLE_TREE = `- id: a
  name: a
  inject:
    external: true
    id: b
- id: b
  name: b
  inject:
    external: true
    id: a
`

describe('compose static analysis', () => {
  test('parses clean trees and finds duplicate ids across sections', () => {
    const composition = parseComposedTreeText(DUP_TREE, 'fixture')
    expect(composition.rows).toHaveLength(2)
    const problems = findCompositionProblems(composition)
    expect(problems).toHaveLength(1)
    expect(problems[0]?.code).toBe('duplicate-id')
    expect(problems[0]?.entries).toEqual(['svc'])
    expect(findCompositionProblems(parseComposedTreeText(CLEAN_TREE, 'fixture'))).toEqual([])
  })

  test('flags invalid patch rows against the active ids', () => {
    const active = parseComposedTreeText(CLEAN_TREE, 'fixture')
    const overlay = [{ id: 'ghost', config: { x: 1 } }]
    const problems = findCompositionProblems(active, overlay)
    expect(problems.some((problem) => problem.code === 'invalid-patch-row')).toBe(true)
  })

  test('flags insert rows naming packages that are not installed', () => {
    const active = parseComposedTreeText(CLEAN_TREE, 'fixture')
    const overlay = [{ insert: [{ id: 'alpha-2', name: '@x/alpha' }] }]
    expect(findCompositionProblems(active, overlay, new Set(['@x/alpha']))).toEqual([])
    const problems = findCompositionProblems(active, overlay, new Set(['@x/beta']))
    expect(problems.some((problem) => problem.code === 'missing-package')).toBe(true)
  })

  test('detects explicit inject-external self and chain cycles', () => {
    const selfLoop = findCompositionProblems(parseComposedTreeText(SELF_CYCLE_TREE, 'fixture'))
    expect(selfLoop.some((problem) => problem.code === 'inject-external-cycle')).toBe(true)
    expect(selfLoop[0]?.entries).toEqual(['loop', 'loop'])
    const chain = findCompositionProblems(parseComposedTreeText(CHAIN_CYCLE_TREE, 'fixture'))
    expect(chain.some((problem) => problem.code === 'inject-external-cycle')).toBe(true)
    expect(chain[0]?.entries).toEqual(['a', 'b', 'a'])
  })

  test('no cycle for acyclic explicit inject-external edges', () => {
    const tree = `- id: c
  name: c
  inject:
    external: true
    id: a
- id: b
  name: b
  inject:
    external: true
    id: a
- id: a
  name: a
`
    expect(findCompositionProblems(parseComposedTreeText(tree, 'fixture'))).toEqual([])
  })
})

describe('runComposeProbe with an injectable runner', () => {
  const base = {
    dshBinary: '/nowhere/dsh',
    profileName: 'web',
    env: { ...process.env, DSH_HOME: '/tmp/lab-home' },
    cwd: '/tmp/lab-home/profiles/web',
  }

  test('passes when the dump exits 0 and the tree is clean', async () => {
    const outcome = await runComposeProbe({
      ...base,
      run: async (args, options) => {
        expect(args).toEqual(['--profile', 'web', '--dump-config'])
        expect(options.env.DSH_HOME).toBe('/tmp/lab-home')
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: CLEAN_TREE,
          stderr: '',
        }
      },
    })
    expect(outcome.problems).toEqual([])
    expect(outcome.probes.every((entry) => entry.status === 'pass')).toBe(true)
  })

  test('fails on non-zero exit or a host patch complaint', async () => {
    const hard = await runComposeProbe({
      ...base,
      run: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: '',
        stderr: 'dsh: [x] patch: entry "ghost" not found',
      }),
    })
    expect(hard.probes[0]?.status).toBe('fail')
    expect(hard.probes[0]?.detail).toContain('not found')
    const soft = await runComposeProbe({
      ...base,
      run: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnError: null,
        stdout: DUP_TREE,
        stderr: '',
      }),
    })
    expect(soft.probes.some((entry) => entry.status === 'fail')).toBe(true)
    expect(soft.problems[0]?.code).toBe('duplicate-id')
  })

  test('fails closed on a runner spawn error', async () => {
    const outcome = await runComposeProbe({
      ...base,
      run: async () => ({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: 'ENOENT',
        stdout: '',
        stderr: '',
      }),
    })
    expect(outcome.probes[0]?.status).toBe('fail')
    expect(outcome.probes[0]?.detail).toContain('ENOENT')
  })
})
