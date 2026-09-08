import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { runSnapshotCreate } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import {
  classifySpec,
  parsePatchListText,
  parseProfileManifest,
  patchSchema,
} from '../domain/composition.js'
import { UsageError, VerificationError } from '../domain/errors.js'
import type { MergeCandidate, MergePreview } from '../domain/merge-types.js'
import { analyzeProfile } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { acquireLock } from '../fs/lock.js'
import { profileDir, profileLockPath } from '../fs/paths.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { resolveLabId } from '../lab/aliases.js'
import { withPackageCache } from '../lab/cache-maintenance.js'
import { createLab, WHITELIST_FILE_NAMES } from '../lab/create.js'
import { requireKnownHost, requirePnpm } from '../lab/gate.js'
import { inheritHome, rebaseHomePaths } from '../lab/home-inheritance.js'
import { labHomeDir, labProfileDir, labRoot } from '../lab/layout.js'
import { localSourceHash } from '../lab/local-source.js'
import { readLabManifest } from '../lab/manifest.js'
import { type LabRunDeps, runLabTransaction } from '../lab/run.js'
import { runCaptured } from '../lab/runner.js'
import { labStorePolicy } from '../lab/store.js'
import { transactionalReplaceFiles } from '../lab/swap.js'
import { lineContext } from './insights.js'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const optional = (path: string) =>
  readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
const mergeRoot = (ctx: CliContext) => join(ctx.home, 'world-line', 'merges')
const pathFor = (ctx: CliContext, id: string) => {
  if (!/^merge-[a-f0-9]{24}$/.test(id)) throw new UsageError('无效合入候选')
  return join(mergeRoot(ctx), id)
}
interface ProfileState {
  home: string
  raw: Record<string, any>
  receipt: string
  fingerprint: string
  patch: Buffer | null
  deps: Map<
    string,
    { spec: string; version?: string; local?: string; hash?: string; blocked?: string }
  >
}
async function profileState(ctx: CliContext): Promise<ProfileState> {
  const dir = profileDir(ctx.home, ctx.profileName)
  const analysis = await analyzeProfile({
    home: ctx.home,
    profileName: ctx.profileName,
    adapter: adapterDsh01x,
  })
  if (
    !analysis.manifest ||
    analysis.manifestParseError ||
    analysis.lockfileParseError ||
    analysis.files.some((file) => file.parseError)
  )
    throw new UsageError('配置无法解析，不能合入')
  const raw = parseProfileManifest(await readFile(join(dir, 'package.json'), 'utf8'), dir).raw
  const patch = await optional(join(dir, 'cordis.patch.yml'))
  const deps: ProfileState['deps'] = new Map()
  for (const dependency of analysis.dependencies) {
    const spec = classifySpec(dependency.spec, dir)
    let hash: string | undefined, blocked: string | undefined
    if (spec.target) {
      try {
        hash = await localSourceHash(spec.target)
      } catch {
        blocked = '本地源码无法固定，请检查大小与符号链接'
      }
    } else if (spec.kind !== 'registry' || !dependency.resolved?.version)
      blocked = '需要已安装的确定版本或本地目录'
    deps.set(dependency.name, {
      spec: dependency.spec,
      version: dependency.resolved?.version,
      local: spec.target,
      hash,
      blocked,
    })
  }
  return {
    home: ctx.home,
    raw,
    patch,
    receipt: analysis.receipt.tree,
    fingerprint: digest(JSON.stringify([analysis.receipt.tree, [...deps]])),
    deps,
  }
}
const bundles = (state: ProfileState): string[] => state.raw.dsh?.profile?.bundles ?? []
const versionLabel = (dep: ReturnType<ProfileState['deps']['get']>) =>
  dep
    ? dep.local
      ? `本地插件${dep.version ? ` · ${dep.version}` : ''}`
      : (dep.version ?? '未解析')
    : '未安装'
async function states(ctx: CliContext, id: string) {
  if (id === 'origin') throw new UsageError('主干无需合入自身')
  const sourceId = await resolveLabId(ctx.home, id)
  const manifest = await readLabManifest(ctx.home, sourceId)
  if (manifest.purpose !== 'mirror') throw new UsageError('请选择交互式世界线')
  const sourceCtx = await lineContext(ctx, sourceId)
  const [target, source] = await Promise.all([profileState(ctx), profileState(sourceCtx)])
  return {
    target,
    source,
    sourceId,
    sourceName: manifest.alias ?? sourceId,
    revision: digest(target.fingerprint + source.fingerprint),
  }
}
export async function mergePreview(ctx: CliContext, id: string): Promise<MergePreview> {
  const { target, source, sourceId, sourceName, revision } = await states(ctx, id)
  return {
    sourceId,
    sourceName,
    revision,
    configChanged:
      !target.patch?.equals(source.patch ?? Buffer.alloc(0)) &&
      (target.patch !== null || source.patch !== null),
    plugins: [...new Set([...target.deps.keys(), ...source.deps.keys()])].sort().map((name) => {
      const before = target.deps.get(name),
        after = source.deps.get(name)
      return {
        name,
        before: versionLabel(before),
        after: versionLabel(after),
        removable: !after,
        changed:
          before?.hash !== after?.hash ||
          before?.version !== after?.version ||
          !!before !== !!after ||
          (!before?.local && !after?.local && before?.spec !== after?.spec) ||
          bundles(target).includes(name) !== bundles(source).includes(name),
        blocked:
          name === '@seaveyon/dsh-world-line'
            ? '管理插件通过发布或 PR 更新，避免合入时替换正在运行的管理器'
            : after?.blocked,
      }
    }),
  }
}
export function mergePackage(
  target: Record<string, any>,
  source: Record<string, any>,
  names: string[],
) {
  const result = structuredClone(target)
  result.dependencies ??= {}
  result.dsh ??= {}
  result.dsh.profile ??= {}
  let list: string[] = [...(result.dsh.profile.bundles ?? [])]
  for (const name of names) {
    if (source.dependencies?.[name] === undefined) delete result.dependencies[name]
    else result.dependencies[name] = source.dependencies[name]
    const wanted = (source.dsh?.profile?.bundles ?? []).includes(name)
    if (!wanted) list = list.filter((item) => item !== name)
    else if (!list.includes(name)) list.push(name)
  }
  result.dsh.profile.bundles = list
  return result
}
export function portablePnpmMetadata(text: string, profile: string, artifacts: string[]): string {
  const paths = artifacts.map(
    (path) => [relative(profile, path).split(sep).join('/'), path] as const,
  )
  const string = (value: string): string => {
    for (const [from, to] of paths) {
      if (value === from) return to
      value = value.replaceAll(`file:${from}`, `file:${to}`)
    }
    return value
  }
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return string(value)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [string(key), visit(item)]),
      )
    return value
  }
  return dump(visit(load(text, { schema: JSON_SCHEMA })), { schema: JSON_SCHEMA })
}
interface StoredCandidate extends MergeCandidate {
  profileName: string
  targetFingerprint: string
  sourceFingerprint: string
  labId: string
  candidateHash: string
  artifactsHash: string | null
}
/** Hash actual installed bytes and symlink identities without following links out of the tree. */
export async function runtimeHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  let count = 0,
    bytes = 0
  const walk = async (relative: string): Promise<void> => {
    const path = join(dir, relative),
      info = await lstat(path)
    hash.update(`${relative}\0${info.mode & 0o111}\0`)
    if (info.isSymbolicLink()) hash.update(await readlink(path))
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(relative, name))
    } else if (info.isFile()) {
      bytes += info.size
      if (++count > 150000 || bytes > 2 * 1024 * 1024 * 1024)
        throw new VerificationError('候选依赖过大，无法固定验证状态')
      hash.update(await readFile(path))
    } else throw new VerificationError('候选包含非普通文件')
  }
  await walk('')
  return hash.digest('hex')
}
/** Keep links portable inside node_modules, or anchored to the immutable merge artifacts. */
export async function prepareRuntimeLinks(modules: string, artifacts: string): Promise<void> {
  modules = await realpath(modules)
  artifacts = await realpath(artifacts).catch(() => resolve(artifacts))
  const inside = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const target = await realpath(path)
      if (!inside(modules, target) && !inside(artifacts, target))
        throw new VerificationError('候选依赖链接指向验证范围外，无法安全合入')
      const portable = inside(modules, target) ? relative(dirname(path), target) : target
      await rm(path)
      await symlink(portable, path)
    } else if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name))
    }
  }
  await walk(modules)
}
const publicCandidate = ({
  id,
  labId,
  sourceId,
  sourceName,
  plugins,
  includeConfig,
  ok,
  detail,
  committed,
  preSnapshot,
}: StoredCandidate): MergeCandidate => ({
  id,
  labId,
  sourceId,
  sourceName,
  plugins,
  includeConfig,
  ok,
  detail,
  committed,
  preSnapshot,
})
async function prepareMergeInternal(
  ctx: CliContext,
  input: { id: string; revision: string; plugins: string[]; includeConfig: boolean },
  deps?: { run?: Partial<LabRunDeps>; install?: typeof runCaptured },
) {
  const lock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'prepare world-line merge',
    breakStale: ctx.breakStaleLock,
  })
  try {
    const preview = await mergePreview(ctx, input.id)
    if (preview.revision !== input.revision) throw new UsageError('主干或来源已变化，请重新预览')
    const names = [...new Set(input.plugins)]
    if (
      (!names.length && !input.includeConfig) ||
      names.some((name) => !preview.plugins.some((item) => item.name === name && !item.blocked))
    )
      throw new UsageError('请选择可合入的插件或配置')
    const host = requireKnownHost(ctx),
      pnpm = requirePnpm(ctx.experimentEnv ?? ctx.env)
    const state = await states(ctx, input.id)
    if (state.revision !== preview.revision) throw new UsageError('配置发生变化，请重新预览')
    const id = `merge-${randomBytes(12).toString('hex')}`,
      root = pathFor(ctx, id)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const created = await createLab(ctx, host, ctx.profileName)
    const labId = created.manifest.id,
      home = labHomeDir(ctx.home, labId),
      dir = labProfileDir(ctx.home, labId, ctx.profileName)
    await inheritHome(ctx.home, home, { skipPaths: [`profiles/${ctx.profileName}`] })
    const pkg = mergePackage(state.target.raw, state.source.raw, names)
    const frozenLocal = new Map<string, string>()
    // Freeze every local dependency independently, outside disposable lab homes.
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies'])
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (typeof spec !== 'string') throw new UsageError('依赖声明无效')
        const owner = field === 'dependencies' && names.includes(name) ? state.source : state.target
        const classified = classifySpec(spec, profileDir(owner.home, ctx.profileName))
        if (classified.target) {
          const before = await localSourceHash(classified.target)
          const suffix = (await lstat(classified.target)).isFile() ? '.tgz' : ''
          const destination = join(
            root,
            'packages',
            digest(`${field}:${name}`).slice(0, 16) + suffix,
          )
          await cp(classified.target, destination, {
            mode: constants.COPYFILE_FICLONE,
            recursive: true,
            filter: (entry) => !['node_modules', '.git', '.env'].includes(basename(entry)),
          })
          if (
            before !== (await localSourceHash(destination)) ||
            before !== (await localSourceHash(classified.target))
          )
            throw new VerificationError('本地源码复制期间变化，请重新验证')
          const info = await lstat(destination)
          if (info.isDirectory()) {
            const file = join(destination, 'package.json'),
              local = JSON.parse(await readFile(file, 'utf8'))
            const patch = local.dsh?.bundle?.patch
            if (
              Array.isArray(local.files) &&
              typeof patch === 'string' &&
              !local.files.includes(patch)
            ) {
              local.files.push(patch)
              await writeFileAtomic(file, JSON.stringify(local, null, 2))
            }
          }
          pkg[field][name] = `file:${destination}`
          frozenLocal.set(name, destination)
        } else if (field === 'dependencies' && names.includes(name)) {
          const version = state.source.deps.get(name)?.version
          if (!version || classified.kind !== 'registry')
            throw new UsageError('无法固定来源插件版本')
          pkg[field][name] = version
        }
      }
    await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    // pnpm may retain an old link: resolution after its spec changes to file:.
    // Invalidate only copied local importers; keep unrelated registry resolutions locked.
    const lockPath = join(dir, 'pnpm-lock.yaml')
    const originalLock = await optional(lockPath)
    if (originalLock) {
      const lock = load(originalLock.toString(), { schema: JSON_SCHEMA }) as Record<string, any>
      for (const field of ['dependencies', 'optionalDependencies', 'devDependencies'])
        for (const name of frozenLocal.keys()) delete lock.importers?.['.']?.[field]?.[name]
      await writeFileAtomic(lockPath, dump(lock, { schema: JSON_SCHEMA }))
    }
    const patchOwner = input.includeConfig ? state.source : state.target
    if (patchOwner.patch)
      await writeFileAtomic(
        join(dir, 'cordis.patch.yml'),
        dump(
          rebaseHomePaths(
            parsePatchListText(patchOwner.patch.toString(), 'profile patch'),
            patchOwner.home,
            home,
          ),
          { schema: patchSchema },
        ),
      )
    else await rm(join(dir, 'cordis.patch.yml'), { force: true })
    const store = labStorePolicy(ctx.home, created.manifest)
    const env = {
      ...store.environment(ctx.experimentEnv ?? ctx.env),
      DSH_HOME: home,
      WORLD_LINE_LAB: labId,
      WORLD_LINE_MANAGER_HOME: ctx.home,
    }
    const install = await (deps?.install ?? runCaptured)(
      pnpm.path,
      ['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile', ...store.flags],
      { cwd: dir, env, timeoutMs: 180000 },
    )
    if (install.exitCode !== 0 || install.spawnError || install.timedOut)
      throw new VerificationError('候选依赖安装失败，主干未改动')
    // Absolute artifact references are valid from both the candidate and main profile.
    // Normalize pnpm metadata before verification so the committed bytes are those verified.
    for (const name of [
      'pnpm-lock.yaml',
      'node_modules/.modules.yaml',
      'node_modules/.pnpm/lock.yaml',
    ]) {
      const path = join(dir, name),
        bytes = await optional(path)
      if (bytes)
        await writeFileAtomic(
          path,
          portablePnpmMetadata(bytes.toString(), dir, [...frozenLocal.values()]),
        )
    }
    const installed = await profileState({ ...ctx, home })
    for (const [name, dependency] of installed.deps) {
      const expected = (names.includes(name) ? state.source : state.target).deps.get(name)
      if (!dependency.local && (!expected?.version || dependency.version !== expected.version))
        throw new VerificationError('候选插件版本与选定来源不一致，请重新预览')
    }
    await prepareRuntimeLinks(join(dir, 'node_modules'), join(root, 'packages'))
    const run = await runLabTransaction({
      ctx,
      host,
      labId,
      plan: [],
      keep: true,
      clientProbes: true,
      deps: deps?.run,
    })
    // Rebase configuration back to main for commit, then validate the same config in an isolated home.
    // The runtime paths are rewritten on commit; the stored hash binds these exact staged bytes.
    const stored: StoredCandidate = {
      id,
      profileName: ctx.profileName,
      sourceId: state.sourceId,
      sourceName: state.sourceName,
      plugins: names,
      includeConfig: input.includeConfig,
      ok: run.ok && run.clientReady === 'pass',
      detail:
        run.ok && run.clientReady === 'pass'
          ? '插件安装、配置、启动与浏览器验证通过'
          : run.clientReady === 'skipped'
            ? '缺少浏览器验证环境。请安装 Chrome，或通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定 Chromium 可执行文件，重启管理实例后重新验证。主干未改动。'
            : '候选验证未通过，主干未改动。请查看验证实验记录。',
      targetFingerprint: state.target.fingerprint,
      sourceFingerprint: state.source.fingerprint,
      labId,
      candidateHash: await runtimeHash(dir),
      artifactsHash: await runtimeHash(join(root, 'packages')).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      }),
    }
    await writeFileAtomic(join(root, 'candidate.json'), JSON.stringify(stored))
    return publicCandidate(stored)
  } finally {
    await lock.release()
  }
}
export async function commitMerge(
  ctx: CliContext,
  id: string,
  deps?: { swap?: typeof transactionalReplaceFiles },
) {
  requireKnownHost(ctx)
  const root = pathFor(ctx, id)
  const serviceLock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'commit world-line merge',
    breakStale: ctx.breakStaleLock,
  })
  try {
    const stored = JSON.parse(
      await readFile(join(root, 'candidate.json'), 'utf8'),
    ) as StoredCandidate
    if (stored.profileName !== ctx.profileName || stored.id !== id)
      throw new UsageError('候选不属于当前 profile')
    if (stored.committed) return publicCandidate(stored)
    if (!stored.ok) throw new VerificationError('验证未通过，不能合入')
    const dir = labProfileDir(ctx.home, stored.labId, ctx.profileName),
      main = profileDir(ctx.home, ctx.profileName)
    const current = await states(ctx, stored.sourceId)
    if (
      current.target.fingerprint !== stored.targetFingerprint ||
      current.source.fingerprint !== stored.sourceFingerprint
    )
      throw new UsageError('主干或来源在验证后变化，请重新预览和验证')
    if ((await runtimeHash(dir)) !== stored.candidateHash)
      throw new VerificationError('验证候选已变化，拒绝合入')
    if (
      stored.artifactsHash &&
      (await runtimeHash(join(root, 'packages'))) !== stored.artifactsHash
    )
      throw new VerificationError('候选本地插件已变化，拒绝合入')
    const pre = await runSnapshotCreate(ctx, { label: `合入前：${stored.sourceName}` })
    if (
      pre.files.some(
        (file) => file.secretSkipped && WHITELIST_FILE_NAMES.some((name) => name === file.name),
      )
    )
      throw new VerificationError('合入前配置备份不完整，请先启用安全密钥服务')
    const lock = await acquireLock({
      lockPath: profileLockPath(ctx.home, ctx.profileName),
      purpose: 'merge verified profile',
      breakStale: ctx.breakStaleLock,
    })
    const backupModules = join(main, `.wl-before-${id}`)
    let hadModules = false,
      movedModules = false,
      movedFiles = false
    const originals = new Map<string, Buffer | null>()
    try {
      const checked = await states(ctx, stored.sourceId)
      if (
        checked.target.fingerprint !== stored.targetFingerprint ||
        checked.source.fingerprint !== stored.sourceFingerprint
      )
        throw new UsageError('主干在备份后发生变化，请重新验证')
      if (
        (await runtimeHash(dir)) !== stored.candidateHash ||
        (stored.artifactsHash &&
          (await runtimeHash(join(root, 'packages'))) !== stored.artifactsHash)
      )
        throw new VerificationError('候选在备份后变化，请重新验证')
      const sourceOf = async (name: string) => {
        const bytes = await optional(join(dir, name))
        if (name === 'cordis.patch.yml' && bytes)
          return dump(
            rebaseHomePaths(
              parsePatchListText(bytes.toString(), 'verified patch'),
              labHomeDir(ctx.home, stored.labId),
              ctx.home,
            ),
            { schema: patchSchema },
          )
        return bytes
      }
      for (const name of WHITELIST_FILE_NAMES) originals.set(name, await optional(join(main, name)))
      // Install the verified dependency tree, keeping the previous tree until all managed files commit.
      await rename(join(main, 'node_modules'), backupModules)
        .then(() => {
          hadModules = true
        })
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
      await rename(join(dir, 'node_modules'), join(main, 'node_modules'))
      movedModules = true
      await (deps?.swap ?? transactionalReplaceFiles)(main, WHITELIST_FILE_NAMES, sourceOf)
      movedFiles = true
      stored.committed = true
      stored.preSnapshot = pre.id
      stored.detail = '已合入主干并保存合入前快照。主干服务未重启；重新启动主干后使用新能力。'
      await writeFileAtomic(join(root, 'candidate.json'), JSON.stringify(stored))
    } catch (error) {
      if (movedFiles)
        await transactionalReplaceFiles(
          main,
          WHITELIST_FILE_NAMES,
          async (name) => originals.get(name) ?? null,
        )
      if (movedModules) await rename(join(main, 'node_modules'), join(dir, 'node_modules'))
      if (hadModules) await rename(backupModules, join(main, 'node_modules'))
      throw error
    } finally {
      await lock.release()
    }
    // Previous runtime remains as recovery evidence alongside the pre-merge snapshot.
    return publicCandidate(stored)
  } finally {
    await serviceLock.release()
  }
}

export async function prepareMerge(...args: Parameters<typeof prepareMergeInternal>) {
  return withPackageCache(args[0].home, () => prepareMergeInternal(...args))
}
