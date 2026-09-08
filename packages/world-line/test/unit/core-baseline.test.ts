import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, rs, test } from '@rstest/core'
import { adapterDsh01x } from '../../src/host-adapters/dsh-0.1.x.js'
import { parseComposedTreeText } from '../../src/lab/compose.js'
import { checkCoreBaseline, loadCoreBaseline } from '../../src/lab/core-baseline.js'
import { requireKnownHost } from '../../src/lab/gate.js'
import { destroyTempHome, installFakeDsh, makeTempHome } from '../helpers/fixture.js'

const { capture } = rs.hoisted(() => ({ capture: rs.fn() }))
rs.mock('../../src/lab/runner.js', () => ({ runCaptured: capture }))
test('trusted core baseline is isolated, cached by binary content, and rejects incomplete evidence', async () => {
  const home = await makeTempHome()
  let root = ''
  let failure = ''
  try {
    const bin = await installFakeDsh(home)
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const ctx = {
      home,
      cwd: home,
      profileName: 'web',
      env: { PATH: bin },
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
    const host = requireKnownHost(ctx)
    const bundles = adapterDsh01x.profile.templates.web!.bundles
    const dump = bundles.map((name, i) => `# == ${name}\n- id: core-${i}\n`).join('')
    capture.mockImplementation(async (_bin, args, options) => {
      root = options.env.DSH_HOME
      expect(root).not.toBe(home)
      expect(options.env.npm_config_ignore_scripts).toBe('true')
      const pkg = JSON.parse(await readFile(join(options.cwd, 'package.json'), 'utf8'))
      expect(Object.keys(pkg.dependencies)).toEqual(bundles)
      const install = args[0] === 'install'
      return {
        exitCode: failure === (install ? 'install' : 'dump') ? 1 : 0,
        stdout: failure === 'markers' ? '[]' : dump,
        stderr: '',
        timedOut: false,
        spawnError: null,
      }
    })
    const baseline = await loadCoreBaseline(ctx, host)
    expect(baseline.rows.length).toBe(bundles.length)
    await expect(access(root)).rejects.toThrow()
    const count = capture.mock.calls.length
    expect(await loadCoreBaseline(ctx, host)).toBe(baseline)
    expect(capture.mock.calls.length).toBe(count)
    await checkCoreBaseline(ctx, host, baseline)
    await expect(
      checkCoreBaseline(ctx, host, parseComposedTreeText('[]', 'missing')),
    ).rejects.toThrow()
    for (const reason of ['install', 'dump', 'markers']) {
      failure = reason
      await writeFile(host.binary.path, `#!/bin/sh\necho ${reason}\n`)
      await expect(loadCoreBaseline(ctx, host)).rejects.toThrow()
      await expect(access(root)).rejects.toThrow()
    }
    failure = ''
    expect((await loadCoreBaseline(ctx, host)).rows.length).toBe(bundles.length)
  } finally {
    await destroyTempHome(home)
  }
})
