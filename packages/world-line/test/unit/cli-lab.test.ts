/**
 * CLI surface tests for the Phase 2 lab commands: grammar errors, exit-code
 * mapping (usage=2), the fail-closed gate without dsh on PATH, empty-home
 * list behavior, and the `--json` envelope. Real dsh/pnpm flows are covered
 * by scripts/evidence-phase2.mjs and the protocol tests with fakes.
 */

import { describe, expect, test } from '@rstest/core'

import { destroyTempHome, makeTempHome, runCliIn } from '../helpers/fixture.js'

async function emptyPathEnv(): Promise<Record<string, string>> {
  return { PATH: '' }
}

describe('lab CLI grammar and gates', () => {
  test('lab without a subcommand is a usage error (exit 2)', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab'], home })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('lab needs a subcommand')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('unknown lab subcommand names available verbs', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'frobnicate', 'x'], home })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('unknown lab subcommand')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('add/remove reject missing or extra positionals', async () => {
    const home = await makeTempHome()
    try {
      const noSpec = await runCliIn({ argv: ['lab', 'add'], home })
      expect(noSpec.exitCode).toBe(2)
      const twoSpecs = await runCliIn({ argv: ['lab', 'add', 'a@1', 'b@2'], home })
      expect(twoSpecs.exitCode).toBe(2)
      const barePath = await runCliIn({ argv: ['lab', 'add', './plugins/x'], home })
      expect(barePath.exitCode).toBe(2)
      expect(barePath.stderr).toContain('file: or link:')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('candidate verbs fail closed with no dsh on PATH (exit 2)', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({
        argv: ['lab', 'add', 'some-plugin@1.0.0', '--keep'],
        home,
        env: await emptyPathEnv(),
      })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('no executable found')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('config apply validates the patch dialect before any lab work', async () => {
    const home = await makeTempHome()
    const { writeFile } = await import('node:fs/promises')
    const patch = '/tmp/wl-cli-bad-patch.yml'
    await writeFile(patch, '- id: [unclosed\n', 'utf8')
    try {
      const run = await runCliIn({ argv: ['lab', 'config', 'apply', patch], home })
      expect(run.exitCode).toBe(2)
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(patch, { force: true }))
      await destroyTempHome(home)
    }
  })

  test('config apply accepts --keep and reaches the fail-closed gate', async () => {
    const home = await makeTempHome()
    const { writeFile } = await import('node:fs/promises')
    const patch = '/tmp/wl-cli-keep-patch.yml'
    await writeFile(patch, '- insert:\n    - id: x\n      name: y\n', 'utf8')
    try {
      const run = await runCliIn({
        argv: ['lab', 'config', 'apply', patch, '--keep'],
        home,
        env: await emptyPathEnv(),
      })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('no executable found')
      expect(run.stderr).not.toContain('takes no positional')
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(patch, { force: true }))
      await destroyTempHome(home)
    }
  })

  test('config apply rejects a missing patch file with exit 2', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({
        argv: ['lab', 'config', 'apply', '/nonexistent/patch.yml'],
        home,
      })
      expect(run.exitCode).toBe(2)
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('lab list/inspect/destroy over an empty home', () => {
  test('lab list prints an empty state and exits 0', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'list'], home })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toContain('no labs')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('lab list --json carries the envelope', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'list', '--json'], home })
      expect(run.exitCode).toBe(0)
      const envelope = JSON.parse(run.stdout) as {
        schemaVersion: number
        ok: boolean
        data: { labs: unknown[] }
      }
      expect(envelope.ok).toBe(true)
      expect(envelope.schemaVersion).toBe(1)
      expect(envelope.data.labs).toEqual([])
    } finally {
      await destroyTempHome(home)
    }
  })

  test('destroy of an unknown id is a usage error', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({
        argv: ['lab', 'destroy', 'lab-20260904T000000Z-00000000'],
        home,
      })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('no such lab')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('inspect of a malformed id is rejected', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'inspect', '..'], home })
      expect(run.exitCode).toBe(2)
    } finally {
      await destroyTempHome(home)
    }
  })
})

describe('lab promote CLI grammar', () => {
  test('promote without a lab id is a usage error (exit 2)', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'promote'], home })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('lab id')
    } finally {
      await destroyTempHome(home)
    }
  })

  test('promote of an unknown lab id is a usage error (exit 2)', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({ argv: ['lab', 'promote', 'lab-no-such'], home })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toMatch(/no such lab|unknown lab|does not exist/i)
    } finally {
      await destroyTempHome(home)
    }
  })

  test('promote accepts --accept-inconclusive and --restart flags', async () => {
    const home = await makeTempHome()
    try {
      const run = await runCliIn({
        argv: ['lab', 'promote', 'lab-no-such', '--accept-inconclusive', '--restart'],
        home,
      })
      expect(run.exitCode).toBe(2)
      expect(run.stderr).toMatch(/no such lab|unknown lab|does not exist/i)
    } finally {
      await destroyTempHome(home)
    }
  })
})
