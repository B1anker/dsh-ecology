import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from '@rstest/core'

import { parseInvocation, runCli } from '../../src/cli.js'
import { loadDshEnvironment, loadExperimentEnvironment } from '../../src/environment.js'
import { destroyTempHome, installFakeDsh, makeTempHome, writeProfile } from '../helpers/fixture.js'

describe('DSH home environment', () => {
  test('shipped CLI passes layered values to rescue while pinning its isolated home', async () => {
    const home = await makeTempHome()
    const userHome = await makeTempHome()
    try {
      await writeProfile(home, 'web')
      await writeFile(join(home, '.env'), 'WL_VALUE=official\nWL_BASE=base\n')
      await mkdir(join(userHome, '.dsh-wl'))
      await writeFile(join(userHome, '.dsh-wl', '.env'), 'WL_VALUE=experiment\nDSH_HOME=/wrong\n')
      const bin = await installFakeDsh(home)
      await writeFile(
        join(bin, 'dsh'),
        '#!/bin/sh\n' +
          'if [ "$1" = "--version" ]; then echo 0.1.2-rc.1; exit 0; fi\n' +
          'case "$DSH_HOME" in */world-line/rescues/*/home) echo isolated-home;; *) echo wrong-home;; esac\n' +
          'echo "value=$WL_VALUE base=${WL_BASE:-absent}"\nexit 1\n',
        { mode: 0o755 },
      )
      const cli = fileURLToPath(new URL('../../bin/dsh-world-line.mjs', import.meta.url))
      for (const [flag, shell, expected] of [
        [false, undefined, 'value=experiment base=base'],
        [true, undefined, 'value=experiment base=absent'],
        [true, 'terminal', 'value=terminal base=absent'],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          [
            cli,
            '--dsh-home',
            home,
            'rescue',
            'start',
            '--json',
            ...(flag ? ['--no-inherit-env'] : []),
          ],
          {
            env: { HOME: userHome, PATH: bin, ...(shell === undefined ? {} : { WL_VALUE: shell }) },
            encoding: 'utf8',
            timeout: 10000,
          },
        )
        expect(result.status).toBe(1)
        const note = JSON.parse(result.stdout).data.note
        expect(note).toContain('isolated-home')
        expect(note).toContain(expected)
      }
      expect(await readFile(join(home, '.env'), 'utf8')).toBe('WL_VALUE=official\nWL_BASE=base\n')
    } finally {
      await destroyTempHome(home)
      await destroyTempHome(userHome)
    }
  })
  test('experiment overlay uses shell > experiment file > official, including empty values', async () => {
    const directory = await makeTempHome()
    try {
      await writeFile(join(directory, '.env'), 'LOGIN_PASSWORD_HASH=lab\nEMPTY=\nSHELL=file\n')
      const official = { LOGIN_PASSWORD_HASH: 'official', EMPTY: 'official', ONLY_OFFICIAL: 'yes' }
      const inherited = { SHELL: 'terminal', LOGIN_PASSWORD_HASH: undefined }
      const env = await loadExperimentEnvironment(official, inherited, { directory })
      expect(env).toEqual({
        LOGIN_PASSWORD_HASH: 'lab',
        EMPTY: '',
        SHELL: 'terminal',
        ONLY_OFFICIAL: 'yes',
      })
      expect(official.LOGIN_PASSWORD_HASH).toBe('official')
      const isolated = await loadExperimentEnvironment(official, inherited, {
        directory,
        inherit: false,
      })
      expect(isolated).toEqual({ LOGIN_PASSWORD_HASH: 'lab', EMPTY: '', SHELL: 'terminal' })
      expect(
        await loadExperimentEnvironment(official, { LOGIN_PASSWORD_HASH: '' }, { directory }),
      ).toMatchObject({ LOGIN_PASSWORD_HASH: '' })
    } finally {
      await destroyTempHome(directory)
    }
  })

  test('missing experiment file inherits dynamically; no-inherit retains only shell values', async () => {
    const home = await makeTempHome()
    const directory = await makeTempHome()
    try {
      for (const value of ['first', 'second']) {
        await writeFile(join(home, '.env'), `VALUE=${value}\n`)
        const official = await loadDshEnvironment(home, {})
        expect((await loadExperimentEnvironment(official, {}, { directory })).VALUE).toBe(value)
        expect(
          await loadExperimentEnvironment(
            official,
            { SHELL: 'kept' },
            { directory, inherit: false },
          ),
        ).toEqual({ SHELL: 'kept' })
      }
      await mkdir(join(directory, '.env'))
      await expect(loadExperimentEnvironment({}, {}, { directory })).rejects.toThrow(
        'cannot read or parse',
      )
      // A broken experiment file has no bearing on official configuration.
      expect((await loadDshEnvironment(home, {})).VALUE).toBe('second')
    } finally {
      await destroyTempHome(home)
      await destroyTempHome(directory)
    }
  })

  test('no-inherit flag is parsed for experiments and rejected on official operations', async () => {
    const home = await makeTempHome()
    try {
      const invocation = parseInvocation(['lab', 'add', '@fixture/test', '--no-inherit-env'], {
        cwd: home,
        env: { DSH_HOME: home },
      })
      expect(invocation.context.noInheritEnv).toBe(true)
      expect(invocation.args).toEqual(['add', '@fixture/test'])
      let stdout = ''
      expect(
        await runCli(['lab', 'promote', 'lab-fixture', '--no-inherit-env', '--json'], {
          env: { DSH_HOME: home },
          out: (text) => {
            stdout += text
          },
        }),
      ).toBe(2)
      expect(JSON.parse(stdout).error.code).toBe('E_USAGE')
    } finally {
      await destroyTempHome(home)
    }
  })
  test('parses literal hashes and quoted values; inherited values win without global mutation', async () => {
    const home = await makeTempHome()
    const before = { ...process.env }
    try {
      await writeFile(
        join(home, '.env'),
        'LOGIN_PASSWORD_HASH="scrypt$0123$abcd"\n' +
          'WORLD_LINE_ENV_TEST="two words # literal"\n' +
          'EMPTY=file\nEXISTING=file\nUNDEFINED=file\n' +
          'LITERAL=$(echo should-not-run)\nDSH_HOME=/wrong/home\n',
      )
      const inherited = { EXISTING: 'shell', EMPTY: '', UNDEFINED: undefined }
      const env = await loadDshEnvironment(home, inherited)
      expect(env).toMatchObject({
        LOGIN_PASSWORD_HASH: 'scrypt$0123$abcd',
        WORLD_LINE_ENV_TEST: 'two words # literal',
        EXISTING: 'shell',
        EMPTY: '',
        UNDEFINED: 'file',
        LITERAL: '$(echo should-not-run)',
        DSH_HOME: home,
      })
      expect(inherited).toEqual({ EXISTING: 'shell', EMPTY: '', UNDEFINED: undefined })
      expect(process.env).toEqual(before)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('missing .env is optional and returns a fresh environment', async () => {
    const home = await makeTempHome()
    try {
      const inherited = { EXISTING: 'shell' }
      const env = await loadDshEnvironment(home, inherited)
      expect(env).toEqual({ EXISTING: 'shell', DSH_HOME: home })
      expect(env).not.toBe(inherited)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('CLI loads the explicitly selected home for encrypted snapshots, not cwd or inherited home', async () => {
    const selected = await makeTempHome()
    const other = await makeTempHome()
    try {
      await writeProfile(selected, 'web', {
        patchYaml: '- id: gate\n  config:\n    apiKey: sk-fixture1234567890abcdef\n',
      })
      await writeFile(join(other, '.env'), 'WORLD_LINE_SECRET_KEY=invalid\n')
      const dotenv = `WORLD_LINE_SECRET_KEY=${'ab'.repeat(32)}\nDSH_HOME=${other}\n`
      await writeFile(join(selected, '.env'), dotenv)
      let stdout = ''
      let stderr = ''
      const exit = await runCli(['--dsh-home', selected, 'snapshot', 'create', '--json'], {
        cwd: other,
        env: { DSH_HOME: other, PATH: '', WORLD_LINE_DISABLE_KEYCHAIN: '1' },
        out: (text) => {
          stdout += text
        },
        err: (text) => {
          stderr += text
        },
      })
      expect(exit).toBe(0)
      const result = JSON.parse(stdout)
      const manifest = JSON.parse(
        await readFile(
          join(selected, 'world-line', 'vault', 'snapshots', `${result.data.id}.json`),
          'utf8',
        ),
      )
      expect(
        manifest.files.find((file: { name: string }) => file.name === 'cordis.patch.yml')
          .secretStored,
      ).toBe(true)
      expect(stdout + stderr).not.toContain('ab'.repeat(32))
      expect(stdout + stderr).not.toContain('sk-fixture1234567890abcdef')
      expect(await readFile(join(selected, '.env'), 'utf8')).toBe(dotenv)
    } finally {
      await destroyTempHome(selected)
      await destroyTempHome(other)
    }
  })

  test('CLI uses inherited DSH_HOME and reports unreadable .env as a file error', async () => {
    const home = await makeTempHome()
    try {
      await mkdir(join(home, '.env'))
      let stdout = ''
      const exit = await runCli(['timeline', 'list', '--json'], {
        env: { DSH_HOME: home },
        out: (text) => {
          stdout += text
        },
      })
      expect(exit).toBe(2)
      expect(JSON.parse(stdout)).toMatchObject({
        command: 'timeline',
        ok: false,
        error: { code: 'E_FILE' },
      })
      expect(stdout).toContain('cannot read or parse')
      expect(await runCli(['--help'], { env: { DSH_HOME: home }, out: () => {} })).toBe(0)
      expect(await runCli(['--version'], { env: { DSH_HOME: home }, out: () => {} })).toBe(0)
    } finally {
      await destroyTempHome(home)
    }
  })
})
