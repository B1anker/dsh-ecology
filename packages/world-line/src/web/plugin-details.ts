import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { CliContext } from '../context.js'
import { parsePatchFile } from '../domain/composition.js'
import { redactTree } from '../domain/redaction.js'
import type { DependencyRecord } from '../domain/snapshot.js'
import { profileDir } from '../fs/paths.js'

/** Static, read-only layers; never execute expressions or claim these are runtime values. */
export async function pluginDetails(ctx: CliContext, dependencies: DependencyRecord[]) {
  const dir = profileDir(ctx.home, ctx.profileName)
  const readLayer = async (path: string) => {
    try {
      return (await parsePatchFile(path)) ?? []
    } catch {
      return null
    }
  }
  const profile = await readLayer(join(dir, 'cordis.patch.yml'))
  const home = await readLayer(join(ctx.home, 'cordis.patch.yml'))
  return Promise.all(
    dependencies.map(async (dep) => {
      let pkg: any,
        root = join(dir, 'node_modules', dep.name)
      try {
        pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      } catch {
        if (dep.target) {
          root = dep.target
          try {
            pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
          } catch {
            /* Missing local package. */
          }
        }
      }
      const ids = new Set<string>()
      const layers: { label: string; entries: unknown[] }[] = []
      const bundle = pkg?.dsh?.bundle?.patch
      let defaults: unknown[] | null = []
      if (typeof bundle === 'string') {
        const path = resolve(root, bundle),
          rel = relative(root, path)
        defaults = rel.startsWith('..') || rel.startsWith('/') ? null : await readLayer(path)
      }
      const selected = (entries: unknown[]): unknown[] =>
        entries.flatMap((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
          const row = raw as Record<string, any>
          const result: unknown[] = []
          if (row.name === dep.name || (typeof row.id === 'string' && ids.has(row.id))) {
            if (typeof row.id === 'string') ids.add(row.id)
            const config = redactTree(row.config ?? {})
            result.push({
              id: row.id,
              disabled: row.disabled,
              fields:
                config && typeof config === 'object'
                  ? Object.entries(config).map(([key, value]) => ({ key, value }))
                  : [],
            })
          }
          if (Array.isArray(row.insert)) result.push(...selected(row.insert))
          return result
        })
      for (const [label, rows] of [
        ['插件自带配置', defaults],
        ['世界线自定义配置', profile],
        ['全局自定义配置', home],
      ] as const) {
        if (rows) {
          const entries = selected(rows)
          if (entries.length) layers.push({ label, entries: redactTree(entries) as unknown[] })
        }
      }
      return {
        name: dep.name,
        displayVersion:
          typeof pkg?.version === 'string' ? pkg.version : (dep.resolved?.version ?? '版本未知'),
        configLayers: layers,
        configIncomplete: defaults === null || profile === null || home === null,
      }
    }),
  )
}
