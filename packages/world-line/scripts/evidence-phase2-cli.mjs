#!/usr/bin/env bun

/**
 * Real-host end-to-end evidence for the Phase 2 CLI (packages/world-line):
 * drives the actual `bin/dsh-world-line.mjs` (dist build) against a temp
 * DSH home and the real dsh 0.1.x binary, asserting the full lab lifecycle —
 *
 *  1. profile gate + empty lab list,
 *  2. `lab add <file:…>` --keep: PASS with a live loopback host,
 *  3. default cleanup on success (no --keep: lab dir deleted),
 *  4. `lab config apply` with a statically-bad overlay: exit 1 + retention,
 *  5. `lab remove` of a package the profile does not have: conservative FAIL,
 *  6. list/inspect/destroy bookkeeping and the `--json` envelope.
 *
 * Requires: real dsh + pnpm on PATH (like scripts/evidence-phase2.mjs) and a
 * fresh `bun run build`. Skips (exit 0, note) when dsh or pnpm is missing so
 * CI — which has neither — stays green. Runs offline: the only candidate
 * plugin is a synthetic `file:` package.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const READY_RE = /^dsh web: (http:\/\/\S+)/

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const EVIDENCE_DIR = resolve(PKG, 'evidence')
const CLI = resolve(PKG, 'bin/dsh-world-line.mjs')
const TRANSCRIPT = []

const assertions = []
const record = (name, ok, detail = '') => {
  assertions.push({ name, ok, detail })
  TRANSCRIPT.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: PKG,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...opts.env },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  return { exit: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Boot dsh with a temp DSH_HOME; resolves once the ready line appears, then
 * kills the process group. Mirrors scripts/evidence-phase2.mjs.
 */
function bootOnce(home, profile, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolveBoot) => {
    const child = spawn('dsh', ['--profile', profile, '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: home },
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (entry) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (process.platform !== 'win32') {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      resolveBoot(entry)
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find((candidate) => READY_RE.test(candidate)) ?? ''
      const match = READY_RE.exec(line)
      if (match?.[1] !== undefined) {
        writeFileSync(join(home, 'boot.log'), `${stdout}\n${stderr}`)
        finish({ url: match[1], stdout, stderr })
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ error: String(error), stdout, stderr }))
    child.on('close', () => finish({ exited: true, stdout, stderr }))
    const timer = setTimeout(() => finish({ timedOut: true, stdout, stderr }), timeoutMs)
  })
}

function cli(home, args, extraEnv = {}) {
  // Pin DSH_HOME explicitly: the ambient shell may already export it.
  return run('node', [CLI, '--dsh-home', home, ...args], {
    env: { DSH_HOME: home, ...extraEnv },
  })
}

function findDshOrPnpm() {
  const probe = (name) =>
    run('sh', ['-lc', `command -v ${name}`], { cwd: PKG }).stdout.trim() !== ''
  return { dsh: probe('dsh'), pnpm: probe('pnpm') }
}

function writePlugin(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@fixture/world-line-probe',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        license: 'MIT',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'index.js'),
    "export const name = '@fixture/world-line-probe'\nexport function apply(ctx) { ctx.logger?.('probe').info('applied') }\n",
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    "- insert:\n    - id: world-line-probe\n      name: '@fixture/world-line-probe'\n",
  )
}

async function main() {
  if (!existsSync(join(PKG, 'dist/index.js'))) {
    console.error('phase2-cli evidence: dist build missing — run `bun run build` first')
    return 1
  }
  const { dsh, pnpm } = findDshOrPnpm()
  if (!dsh || !pnpm) {
    console.log(
      `phase2-cli evidence skipped: real dsh or pnpm not on PATH (dsh=${dsh}, pnpm=${pnpm})`,
    )
    return 0
  }

  const home = mkdtempSync(join(tmpdir(), 'world-line-phase2-cli-'))
  const pluginDir = mkdtempSync(join(tmpdir(), 'world-line-plugin-'))
  try {
    // --- profile bootstrap: booting a fresh home creates the default profile.
    const boot = await bootOnce(home, 'web')
    record(
      'real dsh booted a fresh DSH home and profile web',
      boot.url !== undefined && boot.error === undefined,
      boot.url ?? String(boot.error ?? boot.exited ?? ''),
    )
    // Give the freshly-killed host a moment to fully release its socket/pid.
    await sleep(1200)
    function sleep(ms) {
      return new Promise((done) => setTimeout(done, ms))
    }

    // 1. empty lab list
    let out = cli(home, ['lab', 'list'])
    record(
      'lab list on an empty home exits 0 and reports no labs',
      out.exit === 0 && /no labs/.test(out.stdout),
      out.stdout,
    )

    // 2. lab add file: candidate, kept
    writePlugin(pluginDir)
    out = cli(home, ['lab', 'add', `file:${pluginDir}`, '--keep'])
    record('lab add file: --keep passes', out.exit === 0, out.stdout.split('\n')[0] ?? '')
    const listed = cli(home, ['lab', 'list', '--json'])
    const keptEntry = JSON.parse(listed.stdout).data.labs.find((lab) => lab.state === 'passed')
    const keptId = keptEntry?.id
    record('kept passed lab shows up in lab list', keptId !== undefined, listed.stdout)
    const labsDir = join(home, 'world-line', 'labs', keptId ?? '')

    record(
      'kept lab has manifest + probe.json + logs',
      existsSync(join(labsDir, 'manifest.json')) &&
        existsSync(join(labsDir, 'probe.json')) &&
        existsSync(join(labsDir, 'logs', 'dsh.log')),
      labsDir,
    )
    const probeJson = JSON.parse(readFileSync(join(labsDir, 'probe.json'), 'utf8'))
    record(
      'probe.json records all five acceptance probes (compose, plugin, boot, http)',
      probeJson.summary?.total === 5 &&
        probeJson.summary?.failed === 0 &&
        probeJson.probes.some((p) => p.check === 'compose') &&
        probeJson.probes.some((p) => p.check === 'http-ready'),
      JSON.stringify(probeJson.summary),
    )

    // 3. default cleanup: a second add without --keep must delete its lab.
    const before = cli(home, ['lab', 'list', '--json'])
    const beforeCount = JSON.parse(before.stdout).data.labs.length
    out = cli(home, ['lab', 'add', `file:${pluginDir}`])
    record(
      'lab add default (no --keep) passes',
      out.exit === 0 && /deleted/.test(out.stdout),
      out.stdout,
    )
    const after = cli(home, ['lab', 'list', '--json'])
    record(
      'default cleanup deletes the successful lab',
      JSON.parse(after.stdout).data.labs.length === beforeCount,
      `before=${beforeCount} after=${JSON.parse(after.stdout).data.labs.length}`,
    )

    // 4. config apply with a statically-bad overlay fails closed (exit 1).
    const badPatch = join(pluginDir, 'bad.patch.yml')
    writeFileSync(
      badPatch,
      "- insert:\n    - id: ghost-svc\n      name: '@ghost/never-installed'\n",
    )
    out = cli(home, ['lab', 'config', 'apply', badPatch, '--keep'])
    record(
      'lab config apply with a missing package fails the compose probe (exit 1)',
      out.exit === 1 && /verdict\s+FAIL/.test(out.stdout),
      `exit=${out.exit} ${out.stdout.split('\n')[0] ?? ''}`,
    )
    const failedListed = cli(home, ['lab', 'list', '--json'])
    const failedEntry = JSON.parse(failedListed.stdout).data.labs.find(
      (lab) => lab.state === 'failed',
    )
    const failedId = failedEntry?.id
    const failedManifest = failedId
      ? JSON.parse(
          readFileSync(join(home, 'world-line', 'labs', failedId, 'manifest.json'), 'utf8'),
        )
      : null
    record(
      'failed labs keep a 7-day retention window',
      failedManifest?.state === 'failed' &&
        /^2026-09-1[1-9]T/.test(failedManifest?.retention?.expiresAt ?? ''),
      JSON.stringify(failedManifest?.retention ?? {}),
    )

    // 5. remove of a package the cloned profile does not have: conservative fail.
    out = cli(home, ['lab', 'remove', '@fixture/world-line-probe', '--keep'])
    record(
      'lab remove of an absent package fails conservatively (exit 1)',
      out.exit === 1 && /verdict\s+FAIL/.test(out.stdout),
      out.stdout.split('\n')[0] ?? '',
    )

    // 6. bookkeeping: inspect renders probes; destroy removes; list settles.
    out = cli(home, ['lab', 'inspect', keptId ?? ''])
    record(
      'lab inspect renders the manifest and probe records',
      out.exit === 0 &&
        /state\s+passed/.test(out.stdout) &&
        /\[PASS\] the lab ready URL answers HTTP/.test(out.stdout),
      out.stdout,
    )
    out = cli(home, ['lab', 'destroy', keptId ?? ''])
    record('lab destroy removes the lab', out.exit === 0, out.stdout)
    const finalList = cli(home, ['lab', 'list', '--json'])
    const envelope = JSON.parse(finalList.stdout)
    record(
      'lab list --json carries the schemaVersion envelope',
      envelope.schemaVersion === 1 && envelope.ok === true && Array.isArray(envelope.data.labs),
      finalList.stdout,
    )

    const artifact = {
      kind: 'world-line-phase2-cli-evidence',
      tool: 'dsh-world-line (dist) + real dsh 0.1.x',
      runAt: new Date().toISOString(),
      keptLab: keptId,
      assertions,
      allPassed: assertions.every((a) => a.ok),
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(
      join(EVIDENCE_DIR, 'phase2-cli-evidence.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
    const biome = spawnSync(
      'bunx',
      ['biome', 'check', '--write', join(EVIDENCE_DIR, 'phase2-cli-evidence.json')],
      {
        cwd: join(HERE, '..'),
        stdio: 'ignore',
        timeout: 60_000,
      },
    )
    if (biome.status !== 0 && biome.error === undefined) {
      console.error('phase2-cli evidence: biome could not format the artifact')
    }
    const passed = assertions.filter((a) => a.ok).length
    console.log(
      `phase2-cli evidence: ${passed}/${assertions.length} assertions passed (see evidence/phase2-cli-evidence.json)`,
    )
    return artifact.allPassed ? 0 : 1
  } catch (error) {
    console.error(
      `phase2-cli evidence failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error(`transcript so far:\n${TRANSCRIPT.join('\n')}`)
    return 1
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
}

process.exitCode = await main()
