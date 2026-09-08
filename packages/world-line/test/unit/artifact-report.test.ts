import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'
import { runReport } from '../../src/commands/report.js'
import { labLogDir, newLabId } from '../../src/lab/layout.js'
import { destroyTempHome, makeTempHome } from '../helpers/fixture.js'

describe('private artifact report inventory', () => {
  test('reports index metadata but never artifact bytes, and ignore symlinked content', async () => {
    const home = await makeTempHome()
    try {
      const labId = newLabId(new Date())
      const dir = join(labLogDir(home, labId), 'browser-artifacts', 'probe-123456-fixture')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'trace.zip'), 'PRIVATE_TRACE_CREDENTIALS')
      await writeFile(
        join(dir, 'index.json'),
        JSON.stringify({
          version: 1,
          private: true,
          createdAt: new Date().toISOString(),
          files: ['trace.zip'],
        }),
      )
      const ctx = {
        home,
        profileName: 'web',
        cwd: home,
        env: process.env,
        json: false,
        breakStaleLock: false,
        now: () => new Date(),
      }
      const report = await runReport(ctx, labId)
      expect(report.sections.some((section) => section.title === 'private browser artifacts')).toBe(
        true,
      )
      expect(JSON.stringify(report)).not.toContain('PRIVATE_TRACE_CREDENTIALS')
      expect(await readFile(report.path, 'utf8')).not.toContain('PRIVATE_TRACE_CREDENTIALS')
      expect(report.notes.join(' ')).toContain('尚未脱敏')
      await rm(join(dir, 'trace.zip'))
      await writeFile(join(home, 'outside'), 'DO_NOT_READ')
      await symlink(join(home, 'outside'), join(dir, 'trace.zip'))
      const next = await runReport(ctx, labId)
      expect(
        JSON.stringify(
          next.sections.find((section) => section.title === 'private browser artifacts')?.facts,
        ),
      ).not.toContain('trace.zip')
    } finally {
      await destroyTempHome(home)
    }
  })
})
