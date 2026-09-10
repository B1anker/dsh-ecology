import type { CliContext } from '../context.js'
import { runtimeEnvironment } from '../context.js'
import { diffManifests } from '../domain/diff.js'
import { UsageError } from '../domain/errors.js'
import type { SnapshotDetail, WorldComparison, WorldEvent } from '../domain/insight-types.js'
import { redactText } from '../domain/redaction.js'
import { analyzeProfile, buildManifest, type SnapshotManifest } from '../domain/snapshot.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { resolveLabId } from '../lab/aliases.js'
import { labHomeDir } from '../lab/layout.js'
import { type LabManifest, readLabManifest } from '../lab/manifest.js'
import { listSnapshotManifests, readSnapshotManifest } from '../vault/manifests.js'

export async function lineContext(ctx: CliContext, id: string): Promise<CliContext> {
  if (id === 'origin') return ctx
  const resolved = await resolveLabId(ctx.home, id)
  const manifest = await readLabManifest(ctx.home, resolved)
  if (manifest.source.profileName !== ctx.profileName)
    throw new UsageError('世界线不属于当前 profile')
  if (manifest.state === 'applying') throw new UsageError('世界线正在准备，请完成后重试')
  return { ...ctx, home: labHomeDir(ctx.home, resolved) }
}
export function assertOwnsLine(
  manifest: LabManifest,
  ctx: CliContext,
  message = '世界线不属于当前 profile',
): void {
  if (manifest.source.profileName !== ctx.profileName) throw new UsageError(message)
}
export function snapshotRestorable(manifest: SnapshotManifest) {
  return (
    manifest.profile.dependencies.every(
      (dep) => !['file', 'link'].includes(dep.kind) || !!dep.localSourceHash,
    ) &&
    manifest.files.some((file) => file.name === 'package.json') &&
    manifest.files.every(
      (file) => file.object !== null || (file.secretStored && manifest.secretsBundle !== null),
    ) &&
    (!manifest.homePatch?.present ||
      !!manifest.homePatch.object ||
      (manifest.homePatch.secretStored === true && manifest.secretsBundle !== null))
  )
}

import { snapshotLabel } from '../domain/snapshot-label.js'

export async function snapshotEvents(ctx: CliContext, lineId: string): Promise<WorldEvent[]> {
  const { snapshots } = await listSnapshotManifests(ctx.home)
  return snapshots
    .filter((item) => item.profile.name === ctx.profileName)
    .map((item) => ({
      id: `${lineId}:${item.id}`,
      lineId,
      at: item.createdAt,
      kind: 'snapshot',
      title: redactText(snapshotLabel(item.label)),
      detail: `${item.profile.dependencies.length} 个插件 · ${item.files.length} 份配置文件`,
      snapshotId: item.id,
      restorable: snapshotRestorable(item),
    }))
}
export async function checkedSnapshot(ctx: CliContext, snapshotId: string) {
  const manifest = await readSnapshotManifest(ctx.home, snapshotId)
  if (manifest.profile.name !== ctx.profileName) throw new UsageError('快照不属于当前 profile')
  return manifest
}
export async function snapshotDetail(ctx: CliContext, snapshotId: string): Promise<SnapshotDetail> {
  const item = await checkedSnapshot(ctx, snapshotId)
  return {
    id: item.id,
    at: item.createdAt,
    label: redactText(snapshotLabel(item.label)),
    dependencies: item.profile.dependencies.map((dep) => ({
      name: redactText(dep.name),
      version:
        dep.resolved?.version ?? (dep.kind === 'registry' ? redactText(dep.spec) : '本地依赖'),
    })),
    files: item.files.map((file) => ({
      name: file.name,
      stored: !!file.object || !!file.secretStored,
    })),
    restorable: snapshotRestorable(item),
    warnings: [
      '仅保存插件组成与配置。会话、模型设置、全局凭据及本地插件源码不在快照中；配置内的敏感字段加密保存。',
      ...(!snapshotRestorable(item)
        ? ['快照缺少配置内容或本地源码校验记录，无法从此快照分支。请重新保存快照。']
        : []),
    ],
  }
}
export async function currentManifest(ctx: CliContext, id: string) {
  const analysis = await analyzeProfile({
    home: ctx.home,
    profileName: ctx.profileName,
    adapter: adapterDsh01x,
  })
  if (
    !analysis.manifest ||
    analysis.manifestParseError ||
    analysis.lockfileParseError ||
    analysis.files.some((file) => file.parseError) ||
    analysis.homePatch?.parseError
  )
    throw new UsageError('配置无法解析，请修复后再比较')
  return buildManifest({
    analysis,
    home: ctx.home,
    id,
    createdAt: ctx.now().toISOString(),
    label: null,
    parentId: null,
    dsh: { cliVersion: null, known: false, adapterId: null },
    ...runtimeEnvironment(),
  })
}
export async function compareWorlds(
  ctx: CliContext,
  from: string,
  to: string,
): Promise<WorldComparison> {
  if (from === to) throw new UsageError('请选择两条不同的世界线')
  const [aCtx, bCtx] = await Promise.all([lineContext(ctx, from), lineContext(ctx, to)])
  const [a, b] = await Promise.all([currentManifest(aCtx, from), currentManifest(bCtx, to)])
  const diff = diffManifests(a, b)
  const version = (item: SnapshotManifest, name: string) => {
    const dep = item.profile.dependencies.find((entry) => entry.name === name)
    return dep
      ? (dep.resolved?.version ?? (dep.kind === 'registry' ? redactText(dep.spec) : '本地依赖'))
      : '—'
  }
  return {
    at: ctx.now().toISOString(),
    from,
    to,
    dependencies: diff.dependencies
      .filter((dep) => dep.status !== 'unchanged')
      .map((dep) => ({
        name: redactText(dep.name),
        before: version(a, dep.name),
        after: version(b, dep.name),
        status: dep.status,
        changes: dep.changedFields.map(
          (field) =>
            ({
              spec: '依赖声明',
              kind: '安装方式',
              target: '来源位置',
              gitHead: '代码版本',
              contentHash: '插件清单',
              targetExists: '来源可用性',
              'resolved.version': '安装版本',
              'resolved.integrity': '内容校验',
              'resolved.url': '下载来源',
            })[field] ?? '依赖信息',
        ),
      })),
    files: diff.files.map((file) => ({ name: file.name, status: file.status })),
    patches: diff.patches.map((patch) => ({
      file: patch.file,
      key: redactText(patch.key),
      status: patch.status,
    })),
    bundles: {
      before: a.profile.manifest.bundles.map(redactText),
      after: b.profile.manifest.bundles.map(redactText),
    },
    warnings: [
      '比较读取时的当前配置，运行中的实例可能继续变化。密钥和配置原文不返回浏览器。',
      '本地依赖路径及隔离配置不同也会计入差异，不代表功能一定不同。',
    ],
  }
}
