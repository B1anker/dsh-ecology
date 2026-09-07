import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from '@rstest/core'

import { controlService, readService } from '../../src/lab/service.js'
import {
  destroyTempHome,
  makeTempHome,
  profilePackageJson,
  writeProfile,
} from '../helpers/fixture.js'

const cli = fileURLToPath(new URL('../../bin/dsh-world-line.mjs', import.meta.url))

describe('persistent mirror CLI', () => {
  test('survives CLI exit, uses isolated env/home, refuses promotion/destroy, and stops without touching source', async () => {
    const home = await makeTempHome()
    const userHome = await makeTempHome()
    let id: string | undefined
    const bin = join(home, 'bin')
    try {
      const source = join(home, 'local-source')
      await mkdir(source)
      await writeFile(
        join(source, 'package.json'),
        JSON.stringify({
          name: '@fixture/local',
          version: '1.0.0',
          files: ['dist'],
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      )
      await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
      await writeFile(join(source, '.env'), 'EXCLUDE=fixture\n')
      const profile = await writeProfile(home, 'web', {
        packageJson: profilePackageJson({ dependencies: { '@fixture/local': `link:${source}` } }),
        lockfile: `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@fixture/local':\n        specifier: link:${source}\n        version: link:old-source\n`,
      })
      const before = await readFile(join(profile, 'package.json'), 'utf8')
      await mkdir(join(home, 'auth/dsh-web-login'), { recursive: true })
      await writeFile(
        join(home, 'auth/dsh-web-login/github-users.json'),
        '{"users":[{"role":"owner"}]}',
      )
      await writeFile(join(home, '.env'), 'WL_SAMPLE=official\n')
      await writeFile(
        join(home, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-api-key\n',
      )
      await writeFile(
        join(home, 'settings.yaml'),
        'agent-default-model:\n  provider: deepseek-official\n',
      )
      await mkdir(join(userHome, '.dsh-wl'))
      await writeFile(join(userHome, '.dsh-wl', '.env'), 'WL_SAMPLE=mirror\nDSH_HOME=/wrong\n')
      await mkdir(bin)
      await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      await writeFile(
        join(bin, 'dsh'),
        `#!${process.execPath}\n` +
          String.raw`
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('0.1.2-rc.1'); }
else if (process.argv[2] === 'plugin') { process.exitCode = 0; }
else {
 const server = http.createServer((req, res) => res.end(JSON.stringify({home: process.env.DSH_HOME, sample: process.env.WL_SAMPLE})));
 server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fixture-secret'));
}
`,
        { mode: 0o755 },
      )
      const run = (args: string[]) =>
        spawnSync(process.execPath, [cli, '--dsh-home', home, ...args, '--json'], {
          env: { PATH: bin, HOME: userHome },
          encoding: 'utf8',
          timeout: 20000,
        })
      const start = run(['lab', 'start'])
      expect(start.status).toBe(0)
      const result = JSON.parse(start.stdout).data
      id = result.id
      expect(
        await readFile(
          join(home, 'world-line/labs', result.id, 'home/auth/dsh-web-login/github-users.json'),
          'utf8',
        ),
      ).toContain('owner')
      expect(
        await readFile(
          join(home, 'world-line', 'labs', result.id, 'home/.credentials.yaml'),
          'utf8',
        ),
      ).toContain('fixture-api-key')
      expect(start.stdout + start.stderr).not.toContain('fixture-api-key')
      const clone = JSON.parse(
        await readFile(
          join(home, 'world-line', 'labs', result.id, 'home/profiles/web/package.json'),
          'utf8',
        ),
      )
      const localCopy = clone.dependencies['@fixture/local'].replace(/^file:/, '')
      expect(localCopy).toContain(join(home, 'world-line', 'labs', result.id, 'local-packages'))
      expect(await readFile(join(localCopy, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
      await expect(stat(join(localCopy, '.env'))).rejects.toThrow()
      expect(
        await readFile(
          join(home, 'world-line', 'labs', result.id, 'home/profiles/web/pnpm-lock.yaml'),
          'utf8',
        ),
      ).not.toContain('old-source')
      expect(id).toMatch(/^lab-/)
      const response = await fetch(result.url)
      expect(await response.json()).toEqual({
        home: join(home, 'world-line', 'labs', result.id, 'home'),
        sample: 'mirror',
      })
      const runtime = await readService(home, result.id)
      expect(runtime?.state).toBe('running')
      const privatePath = join(home, 'world-line', 'labs', result.id, 'service.json')
      expect((await stat(privatePath)).mode & 0o777).toBe(0o600)
      expect(await readFile(privatePath, 'utf8')).not.toContain('fixture-secret')
      const rejected = await fetch(`http://127.0.0.1:${runtime?.controlPort}/stop`, {
        method: 'POST',
      })
      expect(rejected.status).toBe(403)
      expect(JSON.parse(run(['lab', 'list']).stdout).data.labs[0].runtimeState).toBe('running')
      expect(run(['lab', 'destroy', result.id]).status).toBe(2)
      expect(run(['lab', 'promote', result.id, '--accept-inconclusive']).status).toBe(2)
      const reused = JSON.parse(run(['lab', 'start']).stdout).data
      expect(reused.id).toBe(result.id)
      expect(reused.pid).toBe(result.pid)
      expect(reused.url).toBe(result.url)
      expect(run(['lab', 'alias', result.id, 'my_name']).status).toBe(0)
      expect(JSON.parse(run(['lab', 'inspect', 'my_name']).stdout).data.manifest.id).toBe(result.id)
      expect(JSON.parse(run(['lab', 'list']).stdout).data.labs[0].alias).toBe('my_name')
      expect(run(['lab', 'alias', result.id, '../bad']).status).toBe(2)
      expect(run(['lab', 'start', 'my_name', '--new']).status).toBe(2)
      expect(run(['lab', 'promote', 'my_name', '--accept-inconclusive']).status).toBe(2)
      expect(run(['lab', 'default', 'my_name']).status).toBe(0)
      expect(JSON.parse(run(['lab', 'default']).stdout).data.id).toBe(result.id)
      expect(JSON.parse(run(['lab', 'list']).stdout).data.labs[0].isDefault).toBe(true)
      expect(run(['lab', 'default', 'my_name', '--clear']).status).toBe(2)
      expect(run(['--profile', 'other', 'lab', 'default', 'my_name']).status).toBe(2)
      const other = JSON.parse(run(['lab', 'start', '--new']).stdout).data
      try {
        expect(other.id).not.toBe(result.id)
        expect(JSON.parse(run(['lab', 'start']).stdout).data.id).toBe(result.id)
        expect(run(['lab', 'alias', other.id, 'my_name']).status).toBe(2)
        expect(run(['lab', 'alias', other.id, 'second']).status).toBe(0)
        expect(run(['lab', 'default', 'second']).status).toBe(0)
        expect(run(['lab', 'alias', 'second', 'renamed']).status).toBe(0)
        expect(JSON.parse(run(['lab', 'default']).stdout).data.alias).toBe('renamed')
        expect(JSON.parse(run(['lab', 'start', 'my_name']).stdout).data.id).toBe(result.id)
        expect(run(['lab', 'inspect', 'second']).status).toBe(2)
        expect(run(['lab', 'stop', 'renamed']).status).toBe(0)
        expect(JSON.parse(run(['lab', 'start']).stdout).data.id).toBe(other.id)
        expect(run(['lab', 'stop', 'renamed']).status).toBe(0)
        expect(run(['lab', 'destroy', 'renamed']).status).toBe(0)
        expect(JSON.parse(run(['lab', 'default']).stdout).data.id).toBe(null)
        expect(run(['lab', 'default', 'my_name']).status).toBe(0)
        expect(run(['lab', 'default', '--clear']).status).toBe(0)
        expect(JSON.parse(run(['lab', 'default']).stdout).data.id).toBe(null)
        expect(run(['lab', 'alias', result.id, 'renamed']).status).toBe(0)
        expect(run(['lab', 'alias', 'renamed', 'my_name']).status).toBe(0)
      } finally {
        const record = await readService(home, other.id).catch(() => null)
        if (record?.state === 'running') await controlService(record, true)
      }
      // A branch clones its selected parent, including data changed after the parent's creation.
      const parentHome = join(home, 'world-line/labs', result.id, 'home')
      await writeFile(join(parentHome, 'branch-note.txt'), 'parent-only')
      const childRun = run(['lab', 'fork', 'my_name', 'child-line'])
      expect(childRun.status).toBe(0)
      const branch = JSON.parse(childRun.stdout).data
      try {
        const childHome = join(home, 'world-line/labs', branch.id, 'home')
        expect(await readFile(join(childHome, 'branch-note.txt'), 'utf8')).toBe('parent-only')
        const inspected = JSON.parse(run(['lab', 'inspect', 'child-line']).stdout).data.manifest
        expect(inspected.source.parentLabId).toBe(result.id)
        expect(inspected.alias).toBe('child-line')
        await writeFile(join(childHome, 'branch-note.txt'), 'child-only')
        expect(await readFile(join(parentHome, 'branch-note.txt'), 'utf8')).toBe('parent-only')
        expect(run(['lab', 'fork', 'my_name', 'child-line']).status).toBe(2)
        expect(JSON.parse(run(['lab', 'start', 'my_name']).stdout).data.port).toBe(result.port)
      } finally {
        run(['lab', 'stop', branch.id])
        run(['lab', 'destroy', branch.id])
      }
      expect(run(['lab', 'stop', 'my_name']).status).toBe(0)
      const marker = join(home, 'world-line', 'labs', result.id, 'home', 'settings.yaml')
      await writeFile(marker, 'custom: preserved\n')
      const blocker = createServer()
      await new Promise<void>((resolve) => blocker.listen(result.port, '127.0.0.1', resolve))
      try {
        expect(run(['lab', 'start', 'my_name']).status).toBe(1)
        expect((await readService(home, result.id))?.port).toBe(result.port)
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
      const resumed = JSON.parse(run(['lab', 'start']).stdout).data
      expect(resumed.id).toBe(result.id)
      expect(resumed.pid).not.toBe(result.pid)
      expect(resumed.port).toBe(result.port)
      expect(await readFile(marker, 'utf8')).toBe('custom: preserved\n')
      expect(JSON.parse(run(['lab', 'start', 'my_name']).stdout).data.id).toBe(result.id)
      const manifestPath = join(home, 'world-line/labs', result.id, 'manifest.json')
      const legacy = JSON.parse(await readFile(manifestPath, 'utf8'))
      delete legacy.homeInheritance
      await writeFile(manifestPath, JSON.stringify(legacy))
      await writeFile(join(home, 'new-plugin-data'), 'backfill')
      const upgraded = JSON.parse(run(['lab', 'start', 'my_name']).stdout).data
      expect(upgraded.id).toBe(result.id)
      expect(upgraded.pid).not.toBe(resumed.pid)
      expect(upgraded.port).toBe(resumed.port)
      expect(
        await readFile(join(home, 'world-line/labs', result.id, 'home/new-plugin-data'), 'utf8'),
      ).toBe('backfill')
      expect(await readFile(marker, 'utf8')).toContain('custom: preserved')
      expect(run(['lab', 'stop', 'my_name']).status).toBe(0)
      await expect(fetch(upgraded.url)).rejects.toThrow()
      await expect(fetch(resumed.url)).rejects.toThrow()
      expect(run(['lab', 'stop', result.id]).status).toBe(0)
      expect(run(['lab', 'stop', result.id]).status).toBe(0)
      await expect(fetch(result.url)).rejects.toThrow()
      expect((await stat(join(home, 'world-line', 'labs', result.id))).isDirectory()).toBe(true)
      expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(before)
      expect(run(['lab', 'destroy', result.id]).status).toBe(0)
    } finally {
      if (id) {
        const record = await readService(home, id).catch(() => null)
        if (record?.state === 'running') await controlService(record, true)
      }
      await destroyTempHome(home)
      await destroyTempHome(userHome)
    }
  }, 30000)
})
