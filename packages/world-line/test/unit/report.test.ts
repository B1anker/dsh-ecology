/**
 * CLI-level tests for `report <lab-id | snapshot-id>`: bundle writes land in
 * world-line/reports with redacted content (log tokens never leak), corrupt
 * targets are recorded as notes instead of failing, and unknown/malformed
 * ids are usage errors (exit 2).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from '@rstest/core'

import { destroyTempHome, makeTempHome, runCliIn } from '../helpers/fixture.js'

async function readNewestBundle(home: string): Promise<unknown> {
  const { readdir } = await import('node:fs/promises')
  const names = await readdir(join(home, 'world-line', 'reports'))
  names.sort()
  const newest = names[names.length - 1]
  if (newest === undefined) throw new Error('no report bundle written')
  return JSON.parse(await readFile(join(home, 'world-line', 'reports', newest), 'utf8')) as unknown
}

const LAB_ID = 'lab-20260904T120000Z-12345678'
const SNAP_ID = 'snap-20260904T110000Z-abcdef00'

async function seedHome(
  home: string,
  options: { corruptLabManifest?: boolean } = {},
): Promise<void> {
  const now = '2026-09-04T12:00:00.000Z'
  const manifest = {
    manifestVersion: 1,
    id: LAB_ID,
    createdAt: now,
    updatedAt: now,
    adapterId: 'dsh-0.1.x',
    dshVersion: '0.1.2-rc.1',
    runtime: { nodeVersion: 'v24', os: 'darwin', arch: 'arm64' },
    source: { profileName: 'web', receipt: 'r'.repeat(64) },
    state: 'passed',
    runCount: 1,
    lastRun: { startedAt: now, finishedAt: now, ok: true, exitCode: 0 },
    plan: [{ seq: 1, action: 'add', id: '@fixture/x', spec: 'file:/tmp/x' }],
    retention: { cleanupMode: 'delete-on-success' },
  }
  const labDir = join(home, 'world-line', 'labs', LAB_ID)
  await mkdir(join(labDir, 'logs'), { recursive: true })
  await mkdir(join(labDir, 'home', 'profiles', 'web'), { recursive: true })
  if (options.corruptLabManifest === true) {
    await writeFile(join(labDir, 'manifest.json'), '{ not json', 'utf8')
  } else {
    await writeFile(join(labDir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  }
  await writeFile(
    join(labDir, 'probe.json'),
    JSON.stringify({
      probes: [
        {
          check: 'host-boot',
          label: 'host boot',
          required: true,
          startedAt: now,
          finishedAt: now,
          status: 'pass',
          detail: 'booted ok',
        },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(labDir, 'logs', 'dsh.log'),
    `ready at 127.0.0.1:5999\n?token=supersecretvalue99\n`,
    'utf8',
  )

  const snapDir = join(home, 'world-line', 'vault', 'snapshots')
  await mkdir(snapDir, { recursive: true })
  await writeFile(
    join(snapDir, `${SNAP_ID}.json`),
    JSON.stringify({
      formatVersion: 1,
      kind: 'profile-snapshot',
      id: SNAP_ID,
      createdAt: '2026-09-04T11:00:00.000Z',
      label: null,
      parentId: null,
      action: 'snapshot',
      candidateSource: null,
      validation: null,
      retention: null,
      createdBy: { worldLineVersion: '0.1.0', environment: { node: 'x', os: 'x', arch: 'x' } },
      dsh: { cliVersion: '0.1.2-rc.1', known: true, adapterId: 'dsh-0.1.x' },
      profile: {
        name: 'web',
        dshHome: '/tmp/x',
        receipt: { algo: 'sha256', files: {}, tree: '0'.repeat(64) },
        manifest: { name: null, bundles: [], patchReload: null },
        dependencies: [],
      },
      files: [],
      homePatch: null,
      derived: { rootConfigPresent: true, rootConfigClean: true },
      unmanaged: [],
    }),
    'utf8',
  )
}

describe('report diagnostics bundles', () => {
  test('snapshot report writes a bundle with the manifest facts', async () => {
    const home = await makeTempHome()
    try {
      await seedHome(home)
      const run = await runCliIn({ argv: ['report', SNAP_ID], home })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toContain('reports/')
      const bundle = (await readNewestBundle(home)) as {
        report: { target: { kind: string } }
        sections: Array<{ title: string }>
        redacted: boolean
      }
      expect(bundle.report.target.kind).toBe('snapshot')
      expect(bundle.sections.map((section) => section.title)).toContain('snapshot manifest')
      expect(bundle.redacted).toBe(true)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('lab report collects manifest, probes, files and redacts log tokens', async () => {
    const home = await makeTempHome()
    try {
      await seedHome(home)
      const run = await runCliIn({ argv: ['report', LAB_ID], home })
      expect(run.exitCode).toBe(0)
      const bundle = (await readNewestBundle(home)) as {
        sections: Array<{ title: string; text?: string }>
      }
      const titles = bundle.sections.map((section) => section.title)
      expect(titles).toContain('lab manifest')
      expect(titles).toContain('probes')
      expect(titles).toContain('log tail: dsh.log')
      const logSection = bundle.sections.find((section) => section.title === 'log tail: dsh.log')
      expect(logSection?.text).not.toContain('supersecretvalue99')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('a corrupt lab manifest is a note, not a failure', async () => {
    const home = await makeTempHome()
    try {
      await seedHome(home, { corruptLabManifest: true })
      const run = await runCliIn({ argv: ['report', LAB_ID], home })
      expect(run.exitCode).toBe(0)
      const bundle = (await readNewestBundle(home)) as { notes: string[] }
      expect(bundle.notes[0]).toMatch(/manifest of lab/)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('unknown or malformed targets are usage errors (exit 2)', async () => {
    const home = await makeTempHome()
    try {
      const unknownLab = await runCliIn({ argv: ['report', LAB_ID], home })
      expect(unknownLab.exitCode).toBe(2)
      expect(unknownLab.stderr).toMatch(/no such lab/)
      const unknownSnap = await runCliIn({ argv: ['report', SNAP_ID], home })
      expect(unknownSnap.exitCode).toBe(2)
      const malformed = await runCliIn({ argv: ['report', 'not-a-target'], home })
      expect(malformed.exitCode).toBe(2)
      expect(malformed.stderr).toMatch(/lab id \(lab-…\) or a snapshot id/)
      const missing = await runCliIn({ argv: ['report'], home })
      expect(missing.exitCode).toBe(2)
    } finally {
      await destroyTempHome(home)
    }
  })
})
