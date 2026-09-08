import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { runSnapshotCreate } from '../commands/snapshot.js'
import type { CliContext } from '../context.js'
import { scanFileText } from '../domain/composition.js'
import { UsageError } from '../domain/errors.js'
import { sha256Hex } from '../fs/hash.js'
import { withOperations } from '../fs/operation.js'
import { withPackageCache } from '../lab/cache-maintenance.js'
import { createLab, WHITELIST_FILE_NAMES } from '../lab/create.js'
import { requireKnownHost, requirePnpm } from '../lab/gate.js'
import { rebaseHomePaths } from '../lab/home-inheritance.js'
import { labDir, labHomeDir, labProfileDir } from '../lab/layout.js'
import { localSourceHash } from '../lab/local-source.js'
import { writeLabManifest } from '../lab/manifest.js'
import { runLabTransaction } from '../lab/run.js'
import { runCaptured } from '../lab/runner.js'
import { sourceContext } from '../lab/source.js'
import { labStorePolicy } from '../lab/store.js'
import { rewriteLocalLock } from '../lab/vendor.js'
import { readSnapshotManifest } from '../vault/manifests.js'
import { readObject } from '../vault/objects.js'
import type { JobHandle } from '../web/jobs.js'

type Entry = { path: string; sha256: string; data: string; executable: boolean }
export interface PortableBundle {
  format: 'world-line-environment'
  version: 1
  profile: string
  dshVersion: string | null
  snapshotId: string
  files: Entry[]
  requiredFiles: string[]
  vendors: { name: string; files: Entry[] }[]
  notes: string[]
}
const MAX = 16 * 1024 * 1024
const allowed = new Set<string>([...WHITELIST_FILE_NAMES, 'home/cordis.patch.yml'])
const forbidden = (name: string) =>
  /^(?:\.env(?:\..*)?|\.git|node_modules)$/.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name)
function safePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length < 1024 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.startsWith('/') &&
    path.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && !forbidden(p))
  )
}
function entry(path: string, bytes: Buffer, executable = false): Entry {
  return { path, sha256: sha256Hex(bytes), data: bytes.toString('base64'), executable }
}
function checkedEntries(entries: unknown, whitelist = false): Entry[] {
  if (!Array.isArray(entries) || entries.length > 20000) throw new UsageError('环境文件列表无效')
  const seen = new Set<string>()
  let bytes = 0
  for (const e of entries) {
    if (
      !e ||
      !safePath(e.path) ||
      (whitelist && !allowed.has(e.path)) ||
      seen.has(e.path) ||
      typeof e.data !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(e.data) ||
      typeof e.executable !== 'boolean'
    )
      throw new UsageError('环境包含重复或不安全的文件路径')
    seen.add(e.path)
    const data = Buffer.from(e.data, 'base64')
    bytes += data.length
    if (bytes > MAX || sha256Hex(data) !== e.sha256) throw new UsageError('环境文件超限或哈希不符')
  }
  return entries
}
export function parsePortable(text: string): PortableBundle {
  if (Buffer.byteLength(text) > MAX * 2) throw new UsageError('环境包超过 32 MiB')
  const b = JSON.parse(text)
  if (
    b?.format !== 'world-line-environment' ||
    b.version !== 1 ||
    typeof b.profile !== 'string' ||
    !Array.isArray(b.requiredFiles) ||
    !Array.isArray(b.vendors) ||
    b.vendors.length > 200
  )
    throw new UsageError('不支持的环境包格式')
  checkedEntries(b.files, true)
  if (b.requiredFiles.some((p: unknown) => typeof p !== 'string' || !allowed.has(p)))
    throw new UsageError('无效秘密输入声明')
  const names = new Set<string>()
  let bytes = b.files.reduce((n: number, e: Entry) => n + Buffer.from(e.data, 'base64').length, 0)
  for (const vendor of b.vendors) {
    if (
      typeof vendor.name !== 'string' ||
      !/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(vendor.name) ||
      names.has(vendor.name)
    )
      throw new UsageError('无效本地插件名称')
    names.add(vendor.name)
    checkedEntries(vendor.files)
    const packageFile = vendor.files.find((f: Entry) => f.path === 'package.json')
    if (!packageFile) throw new UsageError('本地插件缺少 package.json')
    const manifest = JSON.parse(Buffer.from(packageFile.data, 'base64').toString())
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const spec of Object.values(manifest[field] ?? {})) {
        if (typeof spec !== 'string') throw new UsageError('无效本地插件依赖')
        if (/^(?:file:|link:|\/|\.\.?\/|[A-Za-z]:)/.test(spec)) {
          const local = spec.replace(/^(?:file:|link:)/, '')
          const path = relative('/vendor', resolve('/vendor', local))
          if (
            !safePath(path) ||
            !vendor.files.some((f: Entry) => f.path === path || f.path.startsWith(path + '/'))
          )
            throw new UsageError('本地插件还引用包外源码，请先将依赖发布或纳入插件目录再导出')
        }
      }
    bytes += vendor.files.reduce(
      (n: number, e: Entry) => n + Buffer.from(e.data, 'base64').length,
      0,
    )
  }
  if (bytes > MAX) throw new UsageError('环境包解码后超过 16 MiB')
  const pkg = b.files.find((f: Entry) => f.path === 'package.json')
  if (pkg) {
    const manifest = JSON.parse(Buffer.from(pkg.data, 'base64').toString())
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (typeof spec !== 'string') throw new UsageError('Invalid dependency specification')
        if (
          /^(?:file:|link:|\/|\.\.?\/|[A-Za-z]:)/.test(spec) &&
          (!b.vendors.some((v: { name: string }) => v.name === name) ||
            spec !== `file:./.world-line-vendor/${name.replace('/', '__')}`)
        )
          throw new UsageError('Local dependencies must use bundled sources')
      }
  }
  return b
}
export async function exportEnvironment(
  ctx: CliContext,
  snapshotId: string,
): Promise<PortableBundle> {
  return withOperations([ctx.home], ctx.profileName, async () => {
    const snapshot = await readSnapshotManifest(ctx.home, snapshotId)
    if (snapshot.profile.name !== ctx.profileName) throw new UsageError('快照不属于此 profile')
    const bundle: PortableBundle = {
      format: 'world-line-environment',
      version: 1,
      profile: ctx.profileName,
      dshVersion: snapshot.dsh.cliVersion,
      snapshotId,
      files: [],
      requiredFiles: [],
      vendors: [],
      notes: ['不含 secret bundle 或密钥；导入后先在实验验证，不自动合入。'],
    }
    for (const file of snapshot.files) {
      if (!(WHITELIST_FILE_NAMES as readonly string[]).includes(file.name)) continue
      if (!file.object) {
        bundle.requiredFiles.push(file.name)
        continue
      }
      const bytes = await readObject(ctx.home, file.object)
      if (scanFileText(bytes.toString()).length) bundle.requiredFiles.push(file.name)
      else bundle.files.push(entry(file.name, bytes))
    }
    if (snapshot.homePatch?.present) {
      if (snapshot.homePatch.object) {
        const bytes = await readObject(ctx.home, snapshot.homePatch.object)
        if (scanFileText(bytes.toString()).length)
          bundle.requiredFiles.push('home/cordis.patch.yml')
        else bundle.files.push(entry('home/cordis.patch.yml', bytes))
      } else bundle.requiredFiles.push('home/cordis.patch.yml')
    }
    for (const dep of snapshot.profile.dependencies.filter(
      (d) => d.kind === 'file' || d.kind === 'link',
    )) {
      if (!dep.target) throw new UsageError(`本地插件 ${dep.name} 缺少源码路径`)
      const before = await localSourceHash(dep.target)
      if (!dep.localSourceHash || before !== dep.localSourceHash)
        throw new UsageError(`本地插件 ${dep.name} 与快照不一致，请先重新快照`)
      const files: Entry[] = []
      const walk = async (relative: string) => {
        const path = join(dep.target!, relative),
          info = await lstat(path)
        if (info.isSymbolicLink()) throw new UsageError('本地源码含软链接')
        if (info.isDirectory()) {
          for (const name of await readdir(path)) {
            if (forbidden(name)) continue
            await walk(relative ? `${relative}/${name}` : name)
          }
        } else if (info.isFile()) {
          const bytes = await readFile(path)
          if (scanFileText(bytes.toString()).length)
            throw new UsageError(`本地插件 ${dep.name} 含疑似秘密，导出已停止`)
          files.push(entry(relative, bytes, Boolean(info.mode & 0o111)))
        }
      }
      await walk('')
      if ((await localSourceHash(dep.target)) !== before)
        throw new UsageError('导出期间本地插件已变化')
      bundle.vendors.push({ name: dep.name, files })
    }
    if (bundle.vendors.length) {
      const pkg = bundle.files.find((f) => f.path === 'package.json')
      if (!pkg) throw new UsageError('本地插件打包需要不含秘密的 package.json')
      const manifest = JSON.parse(Buffer.from(pkg.data, 'base64').toString())
      for (const dep of snapshot.profile.dependencies) {
        if (['file', 'link'].includes(dep.kind)) {
          for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
            if (manifest[field]?.[dep.name])
              manifest[field][dep.name] = `file:./.world-line-vendor/${dep.name.replace('/', '__')}`
        } else if (dep.resolved?.version) {
          for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
            if (manifest[field]?.[dep.name]) manifest[field][dep.name] = dep.resolved.version
        } else throw new UsageError(`无法固定 ${dep.name} 的解析版本`)
      }
      Object.assign(pkg, entry('package.json', Buffer.from(JSON.stringify(manifest, null, 2))))
      const lock = bundle.files.find((f) => f.path === 'pnpm-lock.yaml')
      if (lock) {
        const mappings = snapshot.profile.dependencies
          .filter((d) => ['file', 'link'].includes(d.kind) && d.target)
          .map((d) => ({
            name: d.name,
            target: d.target!,
            spec: `file:./.world-line-vendor/${d.name.replace('/', '__')}`,
          }))
        const text = dump(
          rewriteLocalLock(
            load(Buffer.from(lock.data, 'base64').toString(), { schema: JSON_SCHEMA }),
            join(snapshot.profile.dshHome, 'profiles', ctx.profileName),
            mappings,
          ),
          { schema: JSON_SCHEMA },
        )
        Object.assign(lock, entry('pnpm-lock.yaml', Buffer.from(text)))
      }
      bundle.notes.push(
        '本地路径已打包并改写；保留远程锁定版本和完整性记录，导入时仅调整本地定位。',
      )
    }
    for (const file of bundle.files.filter((f) => f.path.endsWith('cordis.patch.yml'))) {
      const value = load(Buffer.from(file.data, 'base64').toString(), { schema: JSON_SCHEMA })
      Object.assign(
        file,
        entry(
          file.path,
          Buffer.from(
            dump(rebaseHomePaths(value, snapshot.profile.dshHome, '__WORLD_LINE_HOME__'), {
              schema: JSON_SCHEMA,
            }),
          ),
        ),
      )
    }
    return parsePortable(JSON.stringify(bundle))
  })
}
async function importEnvironmentInternal(
  ctx: CliContext,
  text: string,
  sourceId = 'origin',
  required: Record<string, string> = {},
  handle?: JobHandle,
) {
  const bundle = parsePortable(text)
  if (bundle.profile !== ctx.profileName) throw new UsageError('环境包 profile 与目标不一致')
  for (const name of bundle.requiredFiles)
    if (typeof required[name] !== 'string')
      throw new UsageError(`请在本机补充 ${name}，导出包没有携带该秘密文件`)
  if (Object.keys(required).some((k) => !bundle.requiredFiles.includes(k)))
    throw new UsageError('只接受包中声明的秘密输入')
  if (
    Object.values(required).some((v) => typeof v !== 'string') ||
    Buffer.byteLength(JSON.stringify(required)) > MAX
  )
    throw new UsageError('补充文件无效或超过 16 MiB')
  parsePortable(
    JSON.stringify({
      ...bundle,
      requiredFiles: [],
      files: [
        ...bundle.files.filter((f) => !bundle.requiredFiles.includes(f.path)),
        ...Object.entries(required).map(([name, value]) => entry(name, Buffer.from(value))),
      ],
    }),
  )
  const source = await sourceContext(ctx, sourceId),
    host = requireKnownHost(ctx)
  return withOperations([source.home], ctx.profileName, async () => {
    const baseline = await runSnapshotCreate(source, { label: 'Import baseline' })
    const created = await createLab(ctx, host, ctx.profileName, {
      sourceHome: source.home,
      ...(sourceId !== 'origin' ? { parentLabId: sourceId } : {}),
    })
    const id = created.manifest.id
    created.manifest.source.baselineSnapshotId = baseline.id
    await writeLabManifest(ctx.home, created.manifest, ctx.now())
    handle?.setLabId(id)
    const dir = labProfileDir(ctx.home, id, ctx.profileName)
    for (const name of WHITELIST_FILE_NAMES) await rm(join(dir, name), { force: true })
    const write = async (name: string, bytes: Buffer) => {
      const target =
        name === 'home/cordis.patch.yml'
          ? join(labHomeDir(ctx.home, id), 'cordis.patch.yml')
          : join(dir, name)
      if (name.endsWith('cordis.patch.yml'))
        bytes = Buffer.from(
          dump(
            rebaseHomePaths(
              load(bytes.toString(), { schema: JSON_SCHEMA }),
              '__WORLD_LINE_HOME__',
              labHomeDir(ctx.home, id),
            ),
            { schema: JSON_SCHEMA },
          ),
        )
      await writeFile(target, bytes, { mode: 0o600 })
    }
    for (const file of bundle.files) await write(file.path, Buffer.from(file.data, 'base64'))
    for (const name of bundle.requiredFiles) await write(name, Buffer.from(required[name]!))
    for (const vendor of bundle.vendors) {
      const root = join(ctx.home, 'world-line', 'imports', id, vendor.name.replace('/', '__'))
      for (const file of vendor.files) {
        const path = join(root, file.path)
        await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
        await writeFile(path, Buffer.from(file.data, 'base64'), {
          mode: file.executable ? 0o700 : 0o600,
        })
      }
    }
    if (bundle.vendors.length) {
      const file = join(dir, 'package.json'),
        manifest = JSON.parse(await readFile(file, 'utf8'))
      for (const vendor of bundle.vendors)
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
          if (manifest[field]?.[vendor.name])
            manifest[field][vendor.name] =
              `file:${join(ctx.home, 'world-line', 'imports', id, vendor.name.replace('/', '__'))}`
      await writeFile(file, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      const lock = join(dir, 'pnpm-lock.yaml'),
        text = await readFile(lock, 'utf8').catch((e) => {
          if (e.code === 'ENOENT') return null
          throw e
        })
      if (text !== null)
        await writeFile(
          lock,
          dump(
            rewriteLocalLock(
              load(text, { schema: JSON_SCHEMA }),
              dir,
              bundle.vendors.map((v) => ({
                name: v.name,
                target: join(dir, '.world-line-vendor', v.name.replace('/', '__')),
                spec: `file:${join(ctx.home, 'world-line', 'imports', id, v.name.replace('/', '__'))}`,
              })),
            ),
            { schema: JSON_SCHEMA },
          ),
          { mode: 0o600 },
        )
    }
    const store = labStorePolicy(ctx.home, created.manifest),
      env = store.environment({
        ...(ctx.experimentEnv ?? ctx.env),
        DSH_HOME: labHomeDir(ctx.home, id),
        WORLD_LINE_LAB: id,
        WORLD_LINE_MANAGER_HOME: ctx.home,
      })
    handle?.setPhase('安装导入环境的依赖')
    const install = await runCaptured(
      requirePnpm(ctx.env).path,
      ['install', '--prod', '--ignore-scripts', ...store.flags],
      { cwd: dir, env, timeoutMs: 180000 },
    )
    if (install.exitCode !== 0 || install.timedOut || install.spawnError)
      throw new UsageError(`导入实验 ${id} 安装失败，正式环境未改动`)
    handle?.setPhase('验证导入环境')
    const result = await runLabTransaction({
      ctx,
      host,
      labId: id,
      plan: [],
      keep: true,
      clientProbes: true,
      onProbe: (p) => handle?.pushProbe(p),
    })
    await writeFile(
      join(labDir(ctx.home, id), 'import.json'),
      JSON.stringify({
        version: 1,
        snapshotId: bundle.snapshotId,
        sourceVersion: bundle.dshVersion,
        verified: result.ok,
      }),
      { mode: 0o600 },
    )
    return { ok: result.ok, labId: id, clientGate: result.clientReady, notes: bundle.notes }
  })
}

export async function importEnvironment(...args: Parameters<typeof importEnvironmentInternal>) {
  return withPackageCache(args[0].home, () => importEnvironmentInternal(...args))
}
