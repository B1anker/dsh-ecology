/** Read-only comparison: recorded history and verified health are separate baselines. */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../fs/hash.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { WHITELIST_FILE_NAMES } from '../lab/create.js'
import { localSourceHash } from '../lab/local-source.js'
import { pendingSwaps } from '../lab/swap.js'
import { listTransactions, settled } from '../lab/transaction.js'
import { readSnapshotManifest } from '../vault/manifests.js'
import { readState } from '../vault/state.js'
import { computeReceipt } from './receipt.js'
import type { ProfileAnalysis } from './snapshot.js'

export interface DriftComparison {
  snapshotId: string | null
  status: 'same' | 'changed' | 'missing' | 'unknown'
  changedFiles: string[]
}
export interface DriftResult {
  checkedAt: string
  latest: DriftComparison
  lastKnownGood: DriftComparison
  note?: string
}
export async function detectDrift(
  home: string,
  profileName: string,
  analysis: ProfileAnalysis,
): Promise<DriftResult> {
  const empty = (): DriftComparison => ({ snapshotId: null, status: 'unknown', changedFiles: [] })
  const result: DriftResult = {
    checkedAt: new Date().toISOString(),
    latest: empty(),
    lastKnownGood: empty(),
  }
  try {
    if (
      existsSync(profileLockPath(home, profileName)) ||
      existsSync(
        join(home, 'world-line', 'locks', `operation-${sha256Hex(profileName).slice(0, 16)}.lock`),
      ) ||
      (await pendingSwaps(profileDir(home, profileName))).length ||
      (await listTransactions(home)).some(
        (record) => record.profileName === profileName && !settled(record),
      )
    ) {
      result.note = '环境正在变更或存在未恢复事务，暂不判断漂移。'
      return result
    }
    const state = await readState(home)
    const sourceHashes = new Map<string, Promise<string>>()
    const compare = async (snapshotId?: string): Promise<DriftComparison> => {
      if (!snapshotId) return { snapshotId: null, status: 'missing', changedFiles: [] }
      try {
        const baseline = await readSnapshotManifest(home, snapshotId)
        if (baseline.profile.name !== profileName) throw new Error('baseline profile mismatch')
        const before = baseline.profile.receipt.files,
          after = analysis.receipt.files
        const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((name) => before[name] !== after[name])
          .sort()
        if ((baseline.homePatch?.sha256 ?? null) !== (analysis.homePatch?.sha256 ?? null))
          changedFiles.push('home/cordis.patch.yml')
        let incomplete = false
        const local = new Map(
          baseline.profile.dependencies
            .filter((dep) => dep.kind === 'link' || dep.kind === 'file')
            .map((dep) => [dep.name, dep]),
        )
        for (const dep of analysis.dependencies.filter(
          (dep) => dep.kind === 'link' || dep.kind === 'file',
        )) {
          const prior = local.get(dep.name)
          if (dep.targetExists === true) {
            if (prior?.localSourceHash && dep.target) {
              try {
                if (!sourceHashes.has(dep.target))
                  sourceHashes.set(dep.target, localSourceHash(dep.target))
                if ((await sourceHashes.get(dep.target)) !== prior.localSourceHash)
                  changedFiles.push(`local-source:${dep.name}`)
              } catch {
                incomplete = true
              }
            } else incomplete = true
          }
          if (
            prior &&
            ((prior.contentHash !== undefined && prior.contentHash !== dep.contentHash) ||
              (prior.targetExists !== undefined && prior.targetExists !== dep.targetExists))
          )
            changedFiles.push(`local-plugin:${dep.name}`)
        }
        return {
          snapshotId,
          status: changedFiles.length ? 'changed' : incomplete ? 'unknown' : 'same',
          changedFiles,
        }
      } catch {
        return { snapshotId, status: 'unknown', changedFiles: [] }
      }
    }
    result.latest = await compare(state.lastSnapshots[profileName])
    result.lastKnownGood = await compare(state.lastKnownGood[profileName])
    const names = (await readdir(profileDir(home, profileName))).filter((name) =>
      (WHITELIST_FILE_NAMES as readonly string[]).includes(name),
    )
    const current = await computeReceipt({
      profileDir: profileDir(home, profileName),
      fileNames: names,
    })
    const finalState = await readState(home)
    if (
      finalState.lastSnapshots[profileName] !== state.lastSnapshots[profileName] ||
      finalState.lastKnownGood[profileName] !== state.lastKnownGood[profileName] ||
      current.tree !== analysis.receipt.tree ||
      existsSync(profileLockPath(home, profileName)) ||
      existsSync(
        join(home, 'world-line', 'locks', `operation-${sha256Hex(profileName).slice(0, 16)}.lock`),
      )
    ) {
      result.latest.status = 'unknown'
      result.latest.changedFiles = []
      result.lastKnownGood.status = 'unknown'
      result.lastKnownGood.changedFiles = []
      result.note = '读取期间环境发生变化，请刷新后重试。'
      return result
    }
    result.note =
      (result.latest.status === 'unknown' || result.lastKnownGood.status === 'unknown'
        ? '部分基线无法读取或缺少本地源码记录，暂时不能确认一致。'
        : '') +
      '比较受管配置、home 配置及本地插件源码记录；不检查整个运行环境。一致不代表实例健康，不自动创建快照或更新稳定点。'
  } catch {
    result.latest = empty()
    result.lastKnownGood = empty()
    result.note = '基线或恢复记录无法读取，暂不判断漂移。'
  }
  return result
}
