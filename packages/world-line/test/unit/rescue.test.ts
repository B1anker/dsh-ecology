/**
 * Phase 4 rescue tests: the verbatim block filter (`--allow` semantics), id
 * shape, list/stop over seeded records, usage errors for unknown row ids,
 * and the clean failure path when the boot never becomes ready (fake dsh
 * binary prints the version and exits). Full real-home boots are exercised
 * by the evidence script (skippable on CI).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'
import {
  filterPatchBlocks,
  newRescueId,
  RESCUE_ID_RE,
  rescueDir,
  rescueExists,
  rescueHomeDir,
  runRescueList,
  runRescueStart,
  runRescueStop,
} from '../../src/commands/rescue.js'
import type { CliContext } from '../../src/context.js'
import { UsageError } from '../../src/domain/errors.js'
import {
  destroyTempHome,
  installFakeDsh,
  makeTempHome,
  runCliIn,
  writeProfile,
} from '../helpers/fixture.js'

function makeCtx(home: string, fakeBin: string): CliContext {
  return {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      WORLD_LINE_DISABLE_KEYCHAIN: '1',
    },
    home,
    profileName: 'web',
    json: false,
    breakStaleLock: false,
    now: () => new Date('2026-09-04T12:00:00.000Z'),
  }
}

const PATCH = `- id: ui-settings-models
  config:
    enabled: false
- id: ui-workspace
  config:
    sort: alpha
- id: disabled-row
  disabled: true
  config: {}
`

describe('rescue patch filtering', () => {
  test('keeps only allow-listed rows verbatim and reports disabled ones', () => {
    const { patch, disabled, found } = filterPatchBlocks(PATCH, [
      'ui-workspace',
      'disabled-row',
      'missing-row',
    ])
    expect(found).toEqual(['ui-workspace'])
    expect(disabled).toEqual(['disabled-row'])
    expect(patch).toContain('sort: alpha')
    expect(patch).not.toContain('ui-settings-models')
    expect(patch.split('\n')[0]).toBe('- id: ui-workspace')
  })

  test('empty allow and empty patch both yield core-only []', () => {
    const empty = filterPatchBlocks('[]\n', [])
    expect(empty.patch).toBe('[]\n')
    expect(empty.found).toEqual([])
    const none = filterPatchBlocks(PATCH, [])
    expect(none.patch).toBe('[]\n')
  })
})

describe('rescue records and stop', () => {
  test('newRescueId matches the rescue id contract', () => {
    const id = newRescueId(new Date('2026-09-04T12:34:56.789Z'))
    expect(id).toMatch(/^rescue-20260904T123456Z-[0-9a-f]{8}$/)
    expect(id).toMatch(RESCUE_ID_RE)
  })

  test('list reports running/stale records; stop removes the directory', async () => {
    const home = await makeTempHome()
    try {
      const id = newRescueId(new Date('2026-09-04T12:00:00.000Z'))
      const dir = rescueDir(home, id)
      await mkdir(dir, { recursive: true })
      await mkdir(rescueHomeDir(home, id), { recursive: true })
      const now = '2026-09-04T12:00:00.000Z'
      await writeFile(
        join(dir, 'rescue.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            kind: 'rescue',
            id,
            createdAt: now,
            updatedAt: now,
            profileName: 'web',
            state: 'running',
            pid: 999_999_999,
            port: 51999,
            hostVersion: '0.1.2-rc.1',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const fakeBin = await installFakeDsh(home)
      const ctx = makeCtx(home, fakeBin)
      const listed = await runRescueList(ctx)
      expect(listed.rescues).toHaveLength(1)
      expect(listed.rescues[0]?.id).toBe(id)
      expect(listed.rescues[0]?.state).toBe('running')
      expect(listed.rescues[0]?.alive).toBe(false) // pid 999999999: stale
      const stopped = await runRescueStop(ctx, id)
      expect(stopped.removed).toBe(true)
      expect(await rescueExists(home, id)).toBe(false)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('start with an unknown --allow row is a usage error before anything runs', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      await writeProfile(home, 'web', {
        patchYaml: '- id: ui-workspace\n  config: {}\n',
      })
      const ctx = makeCtx(home, fakeBin)
      await expect(runRescueStart(ctx, ['ui-workspace', 'nope'])).rejects.toBeInstanceOf(UsageError)
      await expect(runRescueStart(ctx, ['nope'])).rejects.toThrow(/no patch row/)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a boot that never becomes ready cleans its directory and reports ok:false', async () => {
    const home = await makeTempHome()
    try {
      const fakeBin = await installFakeDsh(home)
      await writeProfile(home, 'web')
      const run = await runCliIn({
        argv: ['rescue', 'start'],
        home,
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, WORLD_LINE_DISABLE_KEYCHAIN: '1' },
      })
      expect(run.exitCode).toBe(1)
      expect(run.stdout).toContain('FAILED')
      const { readdir } = await import('node:fs/promises')
      const rescues = await readdir(join(home, 'world-line', 'rescues')).catch(() => [])
      expect(rescues).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })
})
