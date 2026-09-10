import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterPatchBlocks } from '../commands/rescue.js'
import { rescueBundles } from '../commands/rescue-bundles.js'
import type { CliContext } from '../context.js'
import { classifySpec } from '../domain/composition.js'
import { UsageError } from '../domain/errors.js'
import { profileDir } from '../fs/paths.js'
import { readTextIfExists } from '../fs/read-json.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { createLab } from './create.js'
import type { KnownHost } from './gate.js'
import { writeLabManifest } from './manifest.js'

/** Build a pristine profile, then hand it to the ordinary mirror lifecycle. */
export async function createCleanLab(
  ctx: CliContext,
  host: KnownHost,
  options: {
    sourceHome: string
    parentLabId?: string
    plugins?: string[]
    copyPluginConfig?: boolean
  },
) {
  const source = profileDir(options.sourceHome, ctx.profileName)
  const names = [...new Set(options.plugins ?? [])]
  const core =
    adapterDsh01x.profile.templates[ctx.profileName]?.bundles ??
    adapterDsh01x.profile.defaultBundles
  const catalog = names.length ? await rescueBundles(source, ctx.profileName) : { bundles: [] }
  const selected = names.map((name) => {
    const bundle = catalog.bundles.find((item) => item.name === name)
    if (!bundle) throw new UsageError(`当前环境没有 bundle ${name}`)
    const classified = classifySpec(bundle.spec, source)
    return { ...bundle, spec: classified.target ? `file:${classified.target}` : bundle.spec }
  })
  let patch = '[]\n'
  if (options.copyPluginConfig && selected.length) {
    const text = (await readTextIfExists(join(source, 'cordis.patch.yml'))) ?? '[]\n'
    patch = filterPatchBlocks(
      text,
      selected.flatMap((item) => item.ids),
      true,
    ).patch
  }
  const seed = await mkdtemp(join(tmpdir(), 'world-line-clean-'))
  try {
    const dir = profileDir(seed, ctx.profileName)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'world-line-clean',
        private: true,
        dependencies: Object.fromEntries(selected.map((item) => [item.name, item.spec])),
        dsh: { profile: { bundles: [...core, ...names] } },
      }),
    )
    await writeFile(join(dir, 'cordis.patch.yml'), patch, { mode: 0o600 })
    const created = await createLab(ctx, host, ctx.profileName, {
      sourceHome: seed,
      parentLabId: options.parentLabId,
    })
    created.manifest.source.initialization = 'clean'
    await writeLabManifest(ctx.home, created.manifest, ctx.now())
    return created
  } finally {
    await rm(seed, { recursive: true, force: true })
  }
}
