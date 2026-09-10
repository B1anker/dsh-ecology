import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSnapshotCreate } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { withOperations } from '../fs/operation.js'
import { readdirIfExists } from '../fs/read-json.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { sourceContext } from '../lab/source.js'
import { readSnapshotManifest } from '../vault/manifests.js'

export type Verdict = 'good' | 'bad' | 'skip'
export interface Trial {
  key: string
  snapshotId?: string
  plugins?: string[]
  labId?: string
  manualLabId?: string
  verdict?: Verdict
  suggested?: Verdict
  error?: string
}
export interface Investigation {
  version: 1
  id: string
  profile: string
  sourceId: string
  kind: 'time' | 'plugins'
  createdAt: string
  revision: number
  baseline: string
  snapshots: string[]
  plugins: string[]
  trials: Trial[]
  active?: Trial
  status: 'ready' | 'running' | 'review' | 'complete' | 'inconclusive'
  candidates: string[]
  note: string
  subset?: string[]
  granularity: number
}
const validId = /^bisect-[0-9a-f-]{36}$/
function path(ctx: CliContext, id: string) {
  if (!validId.test(id)) throw new UsageError('无效排障编号')
  return join(ctx.home, 'world-line', 'investigations', `${id}.json`)
}
export async function readInvestigation(ctx: CliContext, id: string): Promise<Investigation> {
  const s = JSON.parse(await readFile(path(ctx, id), 'utf8'))
  if (s.version !== 1 || s.profile !== ctx.profileName || !Array.isArray(s.trials))
    throw new UsageError('排障记录不属于此环境或已损坏')
  return s
}
export async function saveInvestigation(ctx: CliContext, s: Investigation) {
  s.revision++
  await writeFileAtomic(path(ctx, s.id), JSON.stringify(s))
}
export async function listInvestigations(ctx: CliContext) {
  const files = await readdirIfExists(join(ctx.home, 'world-line', 'investigations'))
  const sessions: Investigation[] = []
  for (const file of files.filter((f) => validId.test(f.replace(/\.json$/, '')))) {
    const raw = JSON.parse(await readFile(path(ctx, file.slice(0, -5)), 'utf8'))
    if (raw.profile === ctx.profileName)
      sessions.push(await readInvestigation(ctx, file.slice(0, -5)))
  }
  return sessions
}
export async function createInvestigation(
  ctx: CliContext,
  kind: 'time' | 'plugins',
  sourceId = 'origin',
  good?: string,
  bad?: string,
) {
  const source = await sourceContext(ctx, sourceId)
  return withOperations([source.home], ctx.profileName, async () => {
    const snapshots: string[] = []
    if (kind === 'time') {
      if (!good || !bad || good === bad) throw new UsageError('请选择不同的已知好点与坏点')
      let cursor: string | null = bad
      while (cursor) {
        if (snapshots.includes(cursor) || snapshots.length >= 10000)
          throw new UsageError('历史链损坏或过长')
        const m = await readSnapshotManifest(source.home, cursor)
        if (m.profile.name !== ctx.profileName) throw new UsageError('快照 profile 不匹配')
        snapshots.push(cursor)
        if (cursor === good) break
        cursor = m.parentId
      }
      if (snapshots.at(-1) !== good) throw new UsageError('好点必须位于坏点的祖先链上')
      snapshots.reverse()
    }
    const analysis = await analyzeProfile({
      home: source.home,
      profileName: ctx.profileName,
      adapter: adapterDsh01x,
    })
    const core =
      adapterDsh01x.profile.templates[ctx.profileName]?.bundles ??
      adapterDsh01x.profile.defaultBundles
    const plugins = analysis.dependencies
      .map((p) => p.name)
      .filter((p) => !core.includes(p))
      .sort()
    if (kind === 'plugins' && !plugins.length) throw new UsageError('没有可排查的非核心插件')
    const baseline =
      kind === 'time' ? bad! : (await runSnapshotCreate(source, { label: '插件排障基线' })).id
    const s: Investigation = {
      version: 1,
      id: `bisect-${randomUUID()}`,
      profile: ctx.profileName,
      sourceId,
      kind,
      createdAt: ctx.now().toISOString(),
      revision: 0,
      baseline,
      snapshots,
      plugins,
      trials: [],
      status: 'ready',
      candidates: [],
      note: '先重新验证两端，再缩小范围；无法判断时跳过。',
      granularity: 2,
    }
    await writeFileAtomic(
      join(source.home, 'world-line', 'workflow-pins', `${s.id}.json`),
      JSON.stringify({ version: 1, snapshots: kind === 'time' ? snapshots : [baseline] }),
    )
    await saveInvestigation(ctx, s)
    return s
  })
}
const keyFor = (plugins: string[]) => `plugins:${[...plugins].sort().join(',')}`
export function nextTrial(s: Investigation): Trial | null {
  if (s.active) return s.active
  if (['complete', 'inconclusive'].includes(s.status)) return null
  const find = (key: string) => s.trials.find((t) => t.key === key)
  if (s.kind === 'time') {
    for (const index of [0, s.snapshots.length - 1]) {
      const key = `snapshot:${s.snapshots[index]}`
      if (!find(key)) return { key, snapshotId: s.snapshots[index] }
    }
    if (
      find(`snapshot:${s.snapshots[0]}`)?.verdict !== 'good' ||
      find(`snapshot:${s.snapshots.at(-1)}`)?.verdict !== 'bad'
    ) {
      s.status = 'inconclusive'
      s.note = '两端复验与预期不符，不能可靠二分。'
      return null
    }
    const good = s.trials
      .filter((t) => t.verdict === 'good')
      .map((t) => s.snapshots.indexOf(t.snapshotId!))
    const bad = s.trials
      .filter((t) => t.verdict === 'bad')
      .map((t) => s.snapshots.indexOf(t.snapshotId!))
    const low = Math.max(...good),
      high = Math.min(...bad)
    if (low >= high) {
      s.status = 'inconclusive'
      s.note = '结果不符合单次引入假设，可能是波动或多次修复。'
      return null
    }
    const available = s.snapshots
      .map((id, i) => ({ id, i }))
      .filter(({ id, i }) => i > low && i < high && !find(`snapshot:${id}`))
    if (!available.length) {
      s.candidates = s.snapshots.slice(low + 1, high + 1)
      s.status = s.candidates.length === 1 ? 'complete' : 'inconclusive'
      s.note =
        s.candidates.length === 1
          ? '已定位首个出现问题的快照；请查看前后差异确认原因。'
          : '跳过的快照使范围无法继续缩小。'
      return null
    }
    available.sort((a, b) => Math.abs(a.i - (low + high) / 2) - Math.abs(b.i - (low + high) / 2))
    return { key: `snapshot:${available[0]!.id}`, snapshotId: available[0]!.id }
  }
  for (const plugins of [s.plugins, []]) {
    const key = keyFor(plugins)
    if (!find(key)) return { key, plugins }
  }
  if (find(keyFor(s.plugins))?.verdict !== 'bad' || find(keyFor([]))?.verdict !== 'good') {
    s.status = 'inconclusive'
    s.note = '完整组合未复现，或仅核心环境仍有问题，不能归因于可选插件。'
    return null
  }
  s.subset ??= [...s.plugins]
  while (true) {
    const current: string[] = s.subset
    if (current.length <= 1) {
      s.candidates = current
      s.status = 'complete'
      s.note = '已找到可复现的最小候选；仍需核对依赖与版本差异。'
      return null
    }
    const size = Math.ceil(current.length / s.granularity)
    const options: string[][] = []
    for (let i = 0; i < current.length; i += size) {
      const chunk = current.slice(i, i + size)
      options.push(
        chunk,
        current.filter((p) => !chunk.includes(p)),
      )
    }
    for (const plugins of options.filter((p) => p.length && p.length < current.length)) {
      const found = find(keyFor(plugins))
      if (!found) return { key: keyFor(plugins), plugins }
      if (found.verdict === 'bad') {
        s.subset = plugins
        s.granularity = 2
        break
      }
    }
    if (s.subset !== current) continue
    if (s.granularity >= current.length) {
      s.candidates = current
      s.status = s.trials.some((t) => t.verdict === 'skip') ? 'inconclusive' : 'complete'
      s.note = '这是组合候选，不能把插件交互问题宣称为单一元凶。'
      return null
    }
    s.granularity = Math.min(current.length, s.granularity * 2)
  }
}
export async function answerInvestigation(
  ctx: CliContext,
  id: string,
  revision: number,
  verdict: Verdict,
) {
  if (!['good', 'bad', 'skip'].includes(verdict)) throw new UsageError('无效判定')
  return withOperations([ctx.home], `investigation:${id}`, async () => {
    const s = await readInvestigation(ctx, id)
    if (s.revision !== revision || s.status !== 'review' || !s.active)
      throw new UsageError('排障进度已变化，请刷新')
    s.active.verdict = verdict
    s.trials.push(s.active)
    delete s.active
    s.status = 'ready'
    nextTrial(s)
    await saveInvestigation(ctx, s)
    return s
  })
}
