import { fork } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'
import type { CliContext } from '../context.js'
import { UsageError, VerificationError } from '../domain/errors.js'
import { redactText } from '../domain/redaction.js'
import { analyzeProfile, type SnapshotManifest } from '../domain/snapshot.js'
import { writeFileAtomic } from '../fs/atomic.js'
import { acquireLock } from '../fs/lock.js'
import { withOperations } from '../fs/operation.js'
import { readTextIfExists } from '../fs/read-json.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { assertAliasAvailable, resolveLabId } from '../lab/aliases.js'
import { withPackageCache } from '../lab/cache-maintenance.js'
import { createCleanLab } from '../lab/clean.js'
import { createLab } from '../lab/create.js'
import { defaultLabId } from '../lab/defaults.js'
import { requireKnownHost, requirePnpm } from '../lab/gate.js'
import { inheritHome, rebaseHomePaths } from '../lab/home-inheritance.js'
import { labDir, labHomeDir, labProfileDir, labRoot, listLabs } from '../lab/layout.js'
import { localSourceHash } from '../lab/local-source.js'
import { readLabManifest, writeLabManifest } from '../lab/manifest.js'
import { runCaptured } from '../lab/runner.js'
import { controlService, readService, servicePath, serviceStatus } from '../lab/service.js'
import { snapshotSource } from '../lab/snapshot-source.js'
import { labStorePolicy } from '../lab/store.js'

export interface LabStartResult {
  ok: true
  id: string
  pid: number
  port: number
  url: string
}

/** Copy local directory dependencies instead of keeping links into the real checkout. */
export async function isolateLocalDependencies(
  ctx: CliContext,
  id: string,
  sourceHome = ctx.home,
  expected?: SnapshotManifest,
): Promise<void> {
  const target = labProfileDir(ctx.home, id, ctx.profileName)
  const path = join(target, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const lockPath = join(target, 'pnpm-lock.yaml')
  const lockText = await readTextIfExists(lockPath)
  const lock =
    lockText === undefined
      ? null
      : (load(lockText) as { importers?: Record<string, Record<string, Record<string, unknown>>> })
  let index = 0
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec !== 'string' || !/^(link:|file:)/.test(spec)) continue
      const source = resolve(
        sourceHome,
        'profiles',
        ctx.profileName,
        spec.replace(/^(link:|file:)/, ''),
      )
      const destination = join(labDir(ctx.home, id), 'local-packages', String(index++))
      // createLab bridges relative lock locators with temporary symlinks.
      // Copying through that destination follows it back into the source.
      const bridged = await lstat(destination).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (bridged?.isSymbolicLink()) await rm(destination)

      // pnpm can retain an old link resolution even after the specifier changes.
      // Remove only this local dependency's importer entry; registry locks stay pinned.
      if (lock?.importers?.['.']?.[field]) delete lock.importers['.'][field][name]
      await mkdir(join(labDir(ctx.home, id), 'local-packages'), { recursive: true })
      if ((await stat(source)).isDirectory()) {
        await cp(source, destination, {
          mode: constants.COPYFILE_FICLONE,
          recursive: true,
          dereference: true,
          filter: (entry) => !['node_modules', '.git', '.env'].includes(basename(entry)),
        })
        if (expected) {
          const dep = expected.profile.dependencies.find((item) => item.name === name)
          if (!dep?.localSourceHash || (await localSourceHash(destination)) !== dep.localSourceHash)
            throw new VerificationError('本地插件在复制过程中变化，请重新保存快照后分支')
        }
        const localManifestPath = join(destination, 'package.json')
        const localManifest = JSON.parse(await readFile(localManifestPath, 'utf8'))
        const patch = localManifest.dsh?.bundle?.patch
        if (Array.isArray(localManifest.files) && typeof patch === 'string') {
          localManifest.files.push(patch)
          await writeFileAtomic(localManifestPath, JSON.stringify(localManifest, null, 2))
        }
        manifest[field][name] = `file:${destination}`
      } else {
        await cp(source, `${destination}.tgz`, { mode: constants.COPYFILE_FICLONE })
        manifest[field][name] = `file:${destination}.tgz`
      }
    }
  }
  await writeFileAtomic(path, JSON.stringify(manifest, null, 2))
  if (index > 0 && lock) await writeFileAtomic(lockPath, dump(lock))
}

async function startMirror(
  ctx: CliContext,
  options: {
    clean?: boolean
    plugins?: string[]
    copyPluginConfig?: boolean
    inheritApiKeys?: boolean
    id?: string
    from?: string
    alias?: string
    snapshotId?: string
  } = {},
): Promise<LabStartResult> {
  const sourceHome = options.from ? labHomeDir(ctx.home, options.from) : ctx.home
  const homes = options.id ? [labHomeDir(ctx.home, options.id)] : [sourceHome]
  return withOperations(homes, ctx.profileName, () =>
    withPackageCache(ctx.home, () => startMirrorUnlocked(ctx, options)),
  )
}
async function startMirrorUnlocked(
  ctx: CliContext,
  options: {
    clean?: boolean
    plugins?: string[]
    copyPluginConfig?: boolean
    inheritApiKeys?: boolean
    id?: string
    from?: string
    alias?: string
    snapshotId?: string
  },
): Promise<LabStartResult> {
  const host = requireKnownHost(ctx)
  const pnpm = requirePnpm(ctx.experimentEnv ?? ctx.env)
  const previous = options.id ? await readLabManifest(ctx.home, options.id) : undefined
  const previousService = options.id ? await readService(ctx.home, options.id) : null
  const sourceHome = options.from ? labHomeDir(ctx.home, options.from) : ctx.home
  const source = options.snapshotId
    ? await snapshotSource({ ...ctx, home: sourceHome }, options.snapshotId)
    : undefined
  const created = previous
    ? { manifest: previous }
    : options.clean
      ? await createCleanLab(ctx, host, {
          sourceHome,
          parentLabId: options.from,
          plugins: options.plugins,
          copyPluginConfig: options.copyPluginConfig,
        })
      : await createLab(ctx, host, ctx.profileName, {
          sourceHome,
          parentLabId: options.from,
          source,
        })
  const id = created.manifest.id
  // Interactive mirrors are not verification evidence and cannot be promoted.
  const manifest = {
    ...created.manifest,
    ...(options.alias ? { alias: options.alias } : {}),
    purpose: 'mirror' as const,
    state: 'applying' as const,
  }
  await writeLabManifest(ctx.home, manifest, ctx.now())
  try {
    if (!previous?.homeInheritance && manifest.source.initialization !== 'clean') {
      const inherited = await inheritHome(sourceHome, labHomeDir(ctx.home, id), {
        apiKeys: options.inheritApiKeys,
        skipPaths: source ? [`profiles/${ctx.profileName}`, 'cordis.patch.yml'] : undefined,
      })
      manifest.homeInheritance = {
        version: 1,
        apiKeys: options.inheritApiKeys !== false,
        ...inherited,
      }
    }
    if (source?.manifest.homePatch?.present) {
      const homePatchPath = join(labHomeDir(ctx.home, id), 'cordis.patch.yml')
      await writeFileAtomic(
        homePatchPath,
        dump(
          rebaseHomePaths(
            load(await readFile(homePatchPath, 'utf8')),
            sourceHome,
            labHomeDir(ctx.home, id),
          ),
        ),
      )
    }
    if (!previous) {
      const patchPath = join(labProfileDir(ctx.home, id, ctx.profileName), 'cordis.patch.yml')
      const patch = await readTextIfExists(patchPath)
      if (patch !== undefined) {
        let rebased: string
        try {
          rebased = dump(rebaseHomePaths(load(patch), sourceHome, labHomeDir(ctx.home, id)))
        } catch {
          throw new VerificationError('cannot parse inherited profile patch')
        }
        await writeFileAtomic(patchPath, rebased)
      }
      await isolateLocalDependencies(ctx, id, sourceHome, source?.manifest)
    }
    const store = labStorePolicy(ctx.home, manifest)
    const env = {
      ...store.environment(ctx.experimentEnv ?? ctx.env),
      DSH_HOME: labHomeDir(ctx.home, id),
      WORLD_LINE_LAB: id,
      WORLD_LINE_MANAGER_HOME: ctx.home,
    }
    if (!previous) {
      const install = await runCaptured(
        pnpm.path,
        [
          'install',
          '--prod',
          '--ignore-scripts',
          source?.manifest.files.some((file) => file.name === 'pnpm-lock.yaml') &&
          !source.manifest.profile.dependencies.some((dep) => ['link', 'file'].includes(dep.kind))
            ? '--frozen-lockfile'
            : '--no-frozen-lockfile',
          ...store.flags,
        ],
        {
          cwd: labProfileDir(ctx.home, id, ctx.profileName),
          env,
          timeoutMs: 180000,
        },
      )
      await writeFileAtomic(
        join(labDir(ctx.home, id), 'logs', 'install.log'),
        redactText(install.stdout + install.stderr),
      )
      if (install.exitCode !== 0 || install.spawnError || install.timedOut)
        throw new VerificationError(`mirror ${id}: dependency installation failed; see lab logs`)
    }
    if (source) {
      const installed = await analyzeProfile({
        home: labHomeDir(ctx.home, id),
        profileName: ctx.profileName,
        adapter: adapterDsh01x,
      })
      for (const dep of source.manifest.profile.dependencies) {
        if (dep.kind !== 'registry' || !dep.resolved?.version) continue
        const actual = installed.dependencies.find((item) => item.name === dep.name)
        if (actual?.resolved?.version !== dep.resolved.version)
          throw new VerificationError('安装后的插件版本与快照不一致，已取消启动')
      }
    }
    const child = fork(
      fileURLToPath(new URL('../lab/service-worker.js', import.meta.url)),
      [ctx.home, id, ctx.profileName, host.binary.path, String(previousService?.port ?? 0)],
      {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
      },
    )
    const result = await new Promise<LabStartResult>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new VerificationError(`mirror ${id}: supervisor startup timed out`))
      }, 130000)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new VerificationError(`mirror ${id}: supervisor exited before ready`))
      })
      child.once('message', (message: LabStartResult | { ok: false; detail: string }) => {
        clearTimeout(timer)
        if (message.ok) {
          child.unref()
          resolveResult(message)
        } else reject(new VerificationError(`mirror ${id}: ${redactText(message.detail)}`))
      })
    })
    await writeLabManifest(ctx.home, { ...manifest, state: 'passed' }, ctx.now())
    return result
  } catch (error) {
    const service = await readService(ctx.home, id).catch(() => null)
    if (service?.state === 'running') await controlService(service, true).catch(() => {})
    const failed = { ...manifest, state: 'failed' as const }
    if (!previous) delete failed.alias
    await writeLabManifest(ctx.home, failed, ctx.now())
    throw error
  }
}

export async function runLabStart(
  ctx: CliContext,
  options: {
    clean?: boolean
    plugins?: string[]
    copyPluginConfig?: boolean
    inheritApiKeys?: boolean
    id?: string
    new?: boolean
    from?: string
    alias?: string
    snapshotId?: string
  } = {},
): Promise<LabStartResult> {
  if (options.clean && (!options.new || options.id || options.snapshotId))
    throw new UsageError('干净环境必须新建，不能与已有实例或快照同时使用')
  if (!options.clean && (options.plugins?.length || options.copyPluginConfig))
    throw new UsageError('插件选择仅适用于干净环境')
  if (options.snapshotId && (!options.new || options.id))
    throw new UsageError('快照分支必须创建新实例')
  if (options.from && (!options.new || options.id))
    throw new UsageError('branch requires a new instance')
  if (options.alias && !options.new) throw new UsageError('alias on start requires --new')
  if (options.new && options.id) throw new UsageError('lab start cannot combine an id with --new')
  const lock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'lab start',
    breakStale: ctx.breakStaleLock,
  })
  try {
    if (options.alias) await assertAliasAvailable(ctx.home, options.alias)
    if (options.from) {
      const from = await resolveLabId(ctx.home, options.from)
      const parent = await readLabManifest(ctx.home, from)
      if (parent.state === 'applying' || parent.state === 'destroyed')
        throw new UsageError('source instance is busy or destroyed')
      return await startMirror(
        { ...ctx, profileName: parent.source.profileName },
        { ...options, from },
      )
    }
    let selected = options.id ? await resolveLabId(ctx.home, options.id) : undefined
    if (!selected && !options.new) selected = await defaultLabId(ctx.home, ctx.profileName)
    if (!selected && !options.new) {
      let stopped: string | undefined
      let latest: string | undefined
      for (const id of await listLabs(ctx.home)) {
        const manifest = await readLabManifest(ctx.home, id)
        if (manifest.purpose !== 'mirror' || manifest.source.profileName !== ctx.profileName)
          continue
        latest ??= id
        const service = await readService(ctx.home, id)
        if (service?.state === 'running') {
          selected = id
          break
        }
        if (!stopped && service?.state === 'stopped') stopped = id
      }
      selected ??= stopped ?? latest
    }
    if (selected) {
      const manifest = await readLabManifest(ctx.home, selected)
      if (manifest.purpose !== 'mirror')
        throw new UsageError('lab start requires a mirror instance')
      const service = await readService(ctx.home, selected)
      if (
        service?.state === 'running' &&
        !manifest.homeInheritance &&
        manifest.source.initialization !== 'clean'
      ) {
        await stopMirror(ctx, selected)
        return await startMirror(
          { ...ctx, profileName: manifest.source.profileName },
          { ...options, id: selected },
        )
      }
      if (service?.state === 'running') {
        const status = await serviceStatus(service)
        if (!status)
          throw new UsageError(
            `lab ${selected}: runtime is unreachable; inspect and stop it before restarting`,
          )
        return {
          ok: true,
          id: selected,
          pid: service.pid,
          port: service.port,
          url: status.url ?? `http://127.0.0.1:${service.port}/`,
        }
      }
      if (!service || service.state !== 'stopped')
        throw new UsageError(`lab ${selected} has no stopped runtime to resume`)
      return await startMirror(
        { ...ctx, profileName: manifest.source.profileName },
        { ...options, id: selected },
      )
    }
    return await startMirror(ctx, options)
  } finally {
    await lock.release()
  }
}

async function stopMirror(ctx: CliContext, id: string): Promise<{ id: string; stopped: true }> {
  return withOperations([labHomeDir(ctx.home, id)], ctx.profileName, () =>
    runLabStopGuarded(ctx, id),
  )
}
async function runLabStopGuarded(
  ctx: CliContext,
  id: string,
): Promise<{ id: string; stopped: true }> {
  await readLabManifest(ctx.home, id)
  const service = await readService(ctx.home, id)
  if (!service) throw new UsageError(`lab ${id} has no persistent instance`)
  if (service.state === 'running') {
    await controlService(service, true)
    await writeFileAtomic(
      servicePath(ctx.home, id),
      JSON.stringify({ ...service, state: 'stopped' }),
      { mode: 0o600 },
    )
  }
  return { id, stopped: true }
}

export async function runLabStop(
  ctx: CliContext,
  id: string,
): Promise<{ id: string; stopped: true }> {
  const lock = await acquireLock({
    lockPath: join(labRoot(ctx.home), '.service.lock'),
    purpose: 'lab stop',
    breakStale: ctx.breakStaleLock,
  })
  try {
    return await stopMirror(ctx, id)
  } finally {
    await lock.release()
  }
}
