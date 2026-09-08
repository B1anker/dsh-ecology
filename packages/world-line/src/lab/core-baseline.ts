import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { sha256Hex } from '../fs/hash.js'
import { adapterDsh01x, dshDumpArgs } from '../host-adapters/dsh-0.1.x.js'
import { type ActiveComposition, assertCoreRows, parseComposedTreeText } from './compose.js'
import type { KnownHost } from './gate.js'
import { requirePnpm } from './gate.js'
import { runCaptured } from './runner.js'
import { labStorePolicy } from './store.js'

const baselines = new Map<string, Promise<ActiveComposition>>()
/** Independent template: exact host version, exact core packages, no user's profile or patches. */
export async function loadCoreBaseline(ctx: CliContext, host: KnownHost) {
  const binary = await realpath(host.binary.path),
    fingerprint = sha256Hex(await readFile(binary))
  const bundles =
    adapterDsh01x.profile.templates[ctx.profileName]?.bundles ??
    adapterDsh01x.profile.defaultBundles
  const key = JSON.stringify([ctx.home, host.raw, ctx.profileName, binary, fingerprint])
  let pending = baselines.get(key)
  if (!pending) {
    pending = (async () => {
      const root = await mkdtemp(join(tmpdir(), 'wl-pristine-'))
      try {
        const dir = join(root, 'profiles', ctx.profileName)
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'world-line-pristine',
            private: true,
            dependencies: Object.fromEntries(bundles.map((name) => [name, host.raw])),
            dsh: { profile: { bundles } },
          }),
        )
        const store = labStorePolicy(ctx.home, {
          id: 'lab-20000101T000000Z-00000000',
          packageStore: 'shared-copy-v1',
        } as any)
        const env = store.environment({
          ...ctx.env,
          DSH_HOME: root,
          WORLD_LINE_MANAGER_HOME: ctx.home,
          npm_config_ignore_scripts: 'true',
          pnpm_config_ignore_scripts: 'true',
        })
        const install = await runCaptured(
          requirePnpm(ctx.env).path,
          ['install', '--prod', '--ignore-scripts', ...store.flags],
          { cwd: dir, env, timeoutMs: 180000 },
        )
        if (install.exitCode !== 0 || install.spawnError || install.timedOut)
          throw new UsageError('无法建立独立核心模板，拒绝把缺失证据当通过')
        const dump = await runCaptured(host.binary.path, dshDumpArgs(ctx.profileName), {
          cwd: dir,
          env,
          timeoutMs: 60000,
        })
        if (dump.exitCode !== 0 || dump.spawnError || dump.timedOut)
          throw new UsageError('独立核心模板无法生成 compose')
        const baseline = parseComposedTreeText(dump.stdout, 'trusted pristine template')
        for (const name of bundles)
          if (!baseline.rows.some((row) => row.sourceBundle === name))
            throw new UsageError(`核心模板缺少 ${name} 来源标记`)
        return baseline
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })()
    baselines.set(key, pending)
    pending.catch(() => baselines.delete(key))
  }
  return await pending
}

export async function checkCoreBaseline(
  ctx: CliContext,
  host: KnownHost,
  candidate: ActiveComposition,
) {
  const bundles =
    adapterDsh01x.profile.templates[ctx.profileName]?.bundles ??
    adapterDsh01x.profile.defaultBundles
  assertCoreRows(candidate, await loadCoreBaseline(ctx, host), new Set(bundles))
}
