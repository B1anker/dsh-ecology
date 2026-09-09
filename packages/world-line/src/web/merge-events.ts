import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import type { WorldEvent } from '../domain/insight-types.js'
import type { MergeCandidate } from '../domain/merge-types.js'
import { redactText } from '../domain/redaction.js'
import { labProfileDir } from '../lab/layout.js'

async function mergePackages(ctx: CliContext, row: MergeCandidate) {
  if (row.packageVersions) return row.packageVersions
  // Historical merges: read the frozen candidate, never today's source/target installation.
  let dependencies: Record<string, string> | undefined
  try {
    dependencies =
      JSON.parse(
        await readFile(
          join(labProfileDir(ctx.home, row.labId, ctx.profileName), 'package.json'),
          'utf8',
        ),
      ).dependencies ?? {}
  } catch {
    /* The temporary experiment may already have been cleaned up. */
  }
  return Promise.all(
    row.plugins.map(async (name) => {
      const hash = createHash('sha256').update(`dependencies:${name}`).digest('hex').slice(0, 16)
      let version = '版本未记录'
      try {
        const pkg = JSON.parse(
          await readFile(
            join(ctx.home, 'world-line', 'merges', row.id, 'packages', hash, 'package.json'),
            'utf8',
          ),
        )
        if (pkg.name === name && typeof pkg.version === 'string') version = pkg.version
      } catch {
        /* Registry dependencies are pinned in the candidate manifest. */
      }
      const spec = dependencies?.[name]
      if (spec && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec)) version = spec
      if (dependencies && !spec) version = '已移除'
      return { name, version }
    }),
  )
}

/** Completed transactions, not their pre-merge backups, are the visible merge nodes. */
export async function projectMerges(ctx: CliContext, events: WorldEvent[]) {
  const root = join(ctx.home, 'world-line', 'merges')
  const ids = await readdir(root).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const id of ids.filter((id) => /^merge-[a-f0-9]+$/.test(id))) {
    try {
      const path = join(root, id, 'candidate.json')
      const row = JSON.parse(await readFile(path, 'utf8')) as MergeCandidate & {
        profileName: string
      }
      if (!row.committed || row.id !== id || row.profileName !== ctx.profileName) continue
      const lineId = row.targetId ?? 'origin'
      const backup = events.find(
        (event) =>
          event.lineId === lineId &&
          event.kind === 'snapshot' &&
          event.snapshotId === row.preSnapshot,
      )
      // Old completed candidates have no timestamp; their atomic file write is the commit record.
      const at = row.committedAt ?? (await stat(path)).mtime.toISOString()
      if (!Number.isFinite(Date.parse(at))) continue
      const source = redactText(row.sourceName)
      const target = redactText(row.targetName ?? 'main')
      const event: WorldEvent = {
        id: `${id}:merged`,
        lineId,
        sourceLineId: row.sourceId,
        at,
        kind: 'merge',
        title: `${source} → ${target} · 合入完成`,
        detail: `已合入 ${row.plugins.length} 个插件${row.includeConfig ? '和运行设置' : ''}。`,
        packageLabel: row.plugins.map(redactText).join('、'),
        packages: (await mergePackages(ctx, row)).map((pkg) => ({
          name: redactText(pkg.name),
          version: redactText(pkg.version),
        })),
        childEventIds: backup ? [backup.id] : [],
      }
      if (backup) {
        backup.parentEventId = event.id
        backup.title = `${target} · 合入前的备份`
        backup.detail = `合入 ${source} 之前保存，可恢复。`
      }
      events.push(event)
    } catch {
      // A partial/corrupt candidate is never evidence that a merge completed.
    }
  }
}
