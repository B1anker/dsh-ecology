import type { CliContext } from '../context.js'
import { UsageError, VerificationError } from '../domain/errors.js'
import { createKeyProvider } from '../vault/crypto.js'
import { readSnapshotManifest } from '../vault/manifests.js'
import { readSecretBundleEntries } from '../vault/secrets.js'
import type { RestoreLabSource } from './create.js'
import { localSourceHash } from './local-source.js'

/** Resolve only a vault belonging to the selected source home; callers never supply a path. */
export async function snapshotSource(
  ctx: CliContext,
  snapshotId: string,
): Promise<RestoreLabSource> {
  const manifest = await readSnapshotManifest(ctx.home, snapshotId)
  if (manifest.profile.name !== ctx.profileName) throw new UsageError('快照不属于当前 profile')
  // Snapshots record local plugin receipts, not their code. Never silently use newer code.
  for (const dep of manifest.profile.dependencies) {
    if (dep.kind !== 'file' && dep.kind !== 'link') continue
    if (!dep.target || !dep.localSourceHash)
      throw new VerificationError('本地插件缺少完整快照凭据，无法从此快照分支')
    const current = await localSourceHash(dep.target)
    if (current !== dep.localSourceHash)
      throw new VerificationError('本地插件源码已变化，无法准确恢复此快照；请从当前状态分支')
  }
  let secrets: Map<string, Buffer> | null = null
  if (manifest.secretsBundle) {
    const key = await createKeyProvider({ home: ctx.home, env: ctx.env }).getOrCreateKey()
    if (!key) throw new VerificationError('快照密钥不可用，无法解密配置')
    secrets = await readSecretBundleEntries(
      ctx.home,
      snapshotId,
      key,
      manifest.secretsBundle.sha256,
    )
  }
  return { snapshotId, manifest, secrets, vaultHome: ctx.home, includeHomePatch: true }
}
