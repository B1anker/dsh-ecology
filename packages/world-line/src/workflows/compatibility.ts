import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CliContext } from '../context.js'
import { UsageError } from '../domain/errors.js'
import { redactText } from '../domain/redaction.js'
import { readDshVersion } from '../host-adapters/detect.js'
import { adapterDsh01x } from '../host-adapters/dsh-0.1.x.js'
import { withPackageCache } from '../lab/cache-maintenance.js'
import { createLab } from '../lab/create.js'
import { type KnownHost, requirePnpm } from '../lab/gate.js'
import { writeLabManifest } from '../lab/manifest.js'
import { runLabTransaction } from '../lab/run.js'
import { runCaptured } from '../lab/runner.js'
import { sourceContext } from '../lab/source.js'
import { installationStorePolicy } from '../lab/store.js'
import type { JobHandle } from '../web/jobs.js'

async function versionMatrixInternal(
  ctx: CliContext,
  versions: string[],
  sourceId: string,
  handle: JobHandle,
) {
  if (
    !versions.length ||
    versions.length > 8 ||
    versions.some((v) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v))
  )
    throw new UsageError('请选择最多 8 个精确宿主版本')
  const source = await sourceContext(ctx, sourceId),
    rows = []
  for (const version of new Set(versions)) {
    handle.setPhase(`验证宿主 ${version}`)
    let labId: string | undefined
    try {
      const root = join(ctx.home, 'world-line', 'host-versions')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const dir = await mkdtemp(join(root, 'host-'))
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'world-line-host-check',
          private: true,
          dependencies: { '@deepseek-ai/dsh': version },
        }),
      )
      const store = installationStorePolicy(join(ctx.home, 'world-line/cache/pnpm-store'))
      const install = await runCaptured(
        requirePnpm(ctx.env).path,
        ['install', '--ignore-scripts', ...store.flags],
        { cwd: dir, env: store.environment(ctx.experimentEnv ?? ctx.env), timeoutMs: 180000 },
      )
      if (install.exitCode !== 0 || install.spawnError || install.timedOut)
        throw new UsageError('候选宿主安装失败')
      const binary = {
          path: join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh'),
        },
        detected = readDshVersion(binary)
      if (!detected || detected.raw.replace(/^v/, '') !== version)
        throw new UsageError('宿主实际版本与请求不符')
      const host: KnownHost = {
        binary,
        version: detected,
        adapterId: adapterDsh01x.id,
        raw: version,
      }
      const created = await createLab(ctx, host, ctx.profileName, {
        sourceHome: source.home,
        ...(sourceId !== 'origin' ? { parentLabId: sourceId } : {}),
      })
      labId = created.manifest.id
      handle.setLabId(labId)
      created.manifest.hostExperiment = { version, binary: binary.path }
      await writeLabManifest(ctx.home, created.manifest, ctx.now())
      const result = await runLabTransaction({
        ctx,
        host,
        labId,
        plan: [],
        keep: true,
        clientProbes: true,
        onProbe: (p) => handle.pushProbe(p),
      })
      rows.push({
        version,
        labId,
        ok: result.ok,
        clientGate: result.clientReady,
        adapterCertified: adapterDsh01x.testedVersions.includes(version),
        promotable: false,
      })
    } catch (e) {
      rows.push({
        version,
        labId,
        ok: false,
        error: redactText(e instanceof Error ? e.message : String(e)),
        promotable: false,
      })
    }
  }
  const result = {
    ok: rows.every((row) => row.ok),
    sourceId,
    rows,
    note: '矩阵试验不修改已认证宿主列表、不升级正式宿主，不允许直接合入跨版本实验。',
  }
  await writeFile(
    join(ctx.home, 'world-line', 'host-versions', `${handle.id}.json`),
    JSON.stringify(result),
    { mode: 0o600 },
  )
  return result
}

export async function versionMatrix(...args: Parameters<typeof versionMatrixInternal>) {
  return withPackageCache(args[0].home, () => versionMatrixInternal(...args))
}
