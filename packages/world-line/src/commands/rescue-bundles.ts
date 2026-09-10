import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parsePatchListText } from '../domain/composition.js'
import { UsageError } from '../domain/errors.js'
import { readTextIfExists } from '../fs/read-json.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'

export async function rescueBundles(profile: string, profileName: string) {
  const core =
    adapterDsh01x.profile.templates[profileName]?.bundles ?? adapterDsh01x.profile.defaultBundles
  const raw = (await readTextIfExists(join(profile, 'package.json'))) ?? '{}'
  const manifest = JSON.parse(raw)
  const names: string[] = manifest.dsh?.profile?.bundles ?? []
  const bundles = []
  for (const name of names) {
    if (core.includes(name)) continue
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new UsageError('无效 bundle 名称')
    const dir = join(profile, 'node_modules', name)
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const patch = pkg.dsh?.bundle?.patch
    if (typeof patch !== 'string') throw new UsageError(`插件 ${name} 缺少 bundle 配置`)
    const path = resolve(dir, patch)
    if (!path.startsWith(resolve(dir) + sep))
      throw new UsageError(`插件 ${name} 的 bundle 路径越界`)
    const rows = parsePatchListText(await readFile(path, 'utf8'), name)
    const ids: string[] = []
    const collect = (rows: unknown[]) => {
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const item = row as { id?: string; insert?: unknown[] }
        if (typeof item.id === 'string') ids.push(item.id)
        if (Array.isArray(item.insert)) collect(item.insert)
      }
    }
    collect(rows)
    bundles.push({ name, ids, spec: manifest.dependencies?.[name] ?? pkg.version })
  }
  return { core, bundles }
}
