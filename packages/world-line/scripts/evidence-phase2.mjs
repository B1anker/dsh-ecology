/**
 * Phase 2 real-DSH evidence run (WORLD-LINE-SPEC §11 Phase 2 acceptance
 * evidence for the lab host-boot contract, mirroring scripts/evidence.mjs).
 *
 * Requires real `dsh` AND real `pnpm` on PATH (dsh plugin management is a
 * pnpm forwarder); exits 0 with a "skipped" note when either is absent. All
 * work happens in fresh temp homes; nothing real is ever touched:
 *
 *   1. boots a fresh auto-initialized profile with --port 0 --no-open and
 *      asserts the readiness line contract (hostReady signal);
 *   2. confirms the ready URL answers HTTP;
 *   3. builds a zero-dependency synthetic bundle plugin, adds it into a lab
 *      home via `dsh plugin … add file:… --ignore-scripts --store-dir …` and
 *      asserts pnpm reconciliation (bundles layer) + isolated store;
 *   4. recomposes and asserts the plugin's patch layer appears;
 *   5. boots the profile WITH the candidate installed and asserts ready again;
 *   6. tears every spawned process group down and writes one evidence/ JSON.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = join(HERE, '..', 'evidence')
const transcript = []
const assertions = []
const READY_RE = /^dsh web: (http:\/\/\S+)/

const step = (name, payload) => ({ name, ...payload })
const record = (name, ok, detail = '') => assertions.push({ name, ok, detail })
const findBinary = (name) => {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Boot dsh with a lab DSH_HOME; resolves once the ready line appears. */
function bootDsh(labHome, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('dsh', ['--profile', 'web', '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: labHome },
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
      resolve(entry)
    }
    const kill = (signal) => {
      try {
        if (child.pid !== undefined)
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
      } catch {
        // already gone
      }
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      const match = READY_RE.exec(stdout.split('\n').find((line) => READY_RE.test(line)) ?? '')
      if (match?.[1] !== undefined) {
        finish({ url: match[1], stdout, stderr, pid: child.pid })
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ error: String(error), stdout, stderr, pid: child.pid }))
    child.on('close', (code) => finish({ exited: code, stdout, stderr, pid: child.pid }))
    const timer = setTimeout(() => {
      finish({ timedOut: true, stdout, stderr, pid: child.pid })
      kill('SIGTERM')
    }, timeoutMs)
  })
}

/** Fetch one URL with a short timeout; returns {status} or {error}. */
async function httpStatus(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    return { status: response.status }
  } catch (error) {
    return { error: String(error) }
  }
}

async function main() {
  if (findBinary('dsh') === null || findBinary('pnpm') === null) {
    console.log('dsh or pnpm not found on PATH — skipping Phase 2 real evidence (CI has neither)')
    return 0
  }
  const labHome = mkdtempSync(join(tmpdir(), 'world-line-phase2-'))
  const pluginDir = mkdtempSync(join(tmpdir(), 'world-line-plugin-'))
  try {
    // ---- 1. Fresh profile boot: readiness-line contract.
    const boot1 = await bootDsh(labHome)
    transcript.push(step('boot-fresh', { ...boot1, stdout: undefined, url: undefined }))
    record(
      'a fresh profile boots with a ready URL carrying host and token',
      typeof boot1.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(boot1.url ?? ''),
      String(boot1.url ?? boot1.error ?? boot1.exited ?? 'timeout'),
    )
    const url1 = boot1.url ?? ''
    const port1 = new URL(url1).port
    record('the ready URL carries a valid port', Number(port1) > 0, port1)
    const probe1 = await httpStatus(url1)
    record(
      'the ready URL answers HTTP',
      probe1.status !== undefined && probe1.status < 500,
      JSON.stringify(probe1),
    )
    killPid(boot1.pid)
    await sleep(700)

    // ---- 2. Synthetic zero-dependency bundle plugin.
    writeFileSync(
      join(pluginDir, 'package.json'),
      `${JSON.stringify(
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
      )}\n`,
    )
    writeFileSync(
      join(pluginDir, 'index.js'),
      "export const name = '@fixture/world-line-probe'\nexport function apply(ctx) { ctx.logger?.('probe').info('applied') }\n",
    )
    writeFileSync(
      join(pluginDir, 'cordis.patch.yml'),
      "- insert:\n    - id: world-line-probe\n      name: '@fixture/world-line-probe'\n",
    )

    // ---- 3. Candidate add through the real pnpm forwarder.
    const add = spawnSync(
      'dsh',
      [
        'plugin',
        '--profile',
        'web',
        'add',
        `file:${pluginDir}`,
        '--ignore-scripts',
        '--store-dir',
        join(labHome, 'pnpm-store'),
      ],
      { env: { ...process.env, DSH_HOME: labHome }, encoding: 'utf8', timeout: 180_000 },
    )
    transcript.push(step('plugin-add', { exit: add.status, stderr: add.stderr?.slice(0, 800) }))
    record(
      'dsh plugin add succeeds offline for a file: bundle',
      add.status === 0,
      `exit ${String(add.status)}`,
    )
    const manifest = JSON.parse(
      readFileSync(join(labHome, 'profiles', 'web', 'package.json'), 'utf8'),
    )
    transcript.push(step('manifest-after-add', { manifest }))
    record(
      'pnpm reconciliation appends the bundle to dsh.profile.bundles',
      JSON.stringify(manifest.dsh.profile.bundles) ===
        JSON.stringify([
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@fixture/world-line-probe',
        ]),
      JSON.stringify(manifest.dsh.profile.bundles),
    )
    record(
      'the lab store directory was used',
      existsSync(join(labHome, 'pnpm-store', 'v11')) || existsSync(join(labHome, 'pnpm-store')),
      '',
    )

    // ---- 4. Compose includes the candidate layer.
    const dump = spawnSync('dsh', ['--profile', 'web', '--dump-config'], {
      env: { ...process.env, DSH_HOME: labHome },
      encoding: 'utf8',
      timeout: 60_000,
    })
    const composed = dump.stdout ?? ''
    record(
      'dump-config composes with the candidate patch layer',
      dump.status === 0 &&
        composed.includes('# == @fixture/world-line-probe') &&
        composed.includes('id: world-line-probe'),
      dump.status === 0 ? 'section present' : (dump.stderr ?? '').slice(0, 300),
    )

    // ---- 5. Boot WITH the candidate installed (host readiness incl. plugin).
    const boot2 = await bootDsh(labHome)
    transcript.push(step('boot-with-candidate', { ...boot2, stdout: undefined, url: undefined }))
    record(
      'the lab profile boots with the candidate plugin loaded',
      typeof boot2.url === 'string',
      String(boot2.url ?? boot2.error ?? boot2.exited ?? 'timeout'),
    )
    if (typeof boot2.url === 'string') {
      const probe2 = await httpStatus(boot2.url)
      record(
        'the lab ready URL answers HTTP',
        probe2.status !== undefined && probe2.status < 500,
        JSON.stringify(probe2),
      )
    }
    killPid(boot2.pid)
    await sleep(700)

    // ---- Artifact.
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const artifact = {
      dshVersion: spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
      pnpmVersion: spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
      runAt: new Date().toISOString(),
      labHome,
      transcript,
      assertions,
      allPassed: assertions.every((a) => a.ok),
    }
    writeFileSync(
      join(EVIDENCE_DIR, 'phase2-evidence.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
    const biome = spawnSync(
      'bunx',
      ['biome', 'check', '--write', join(EVIDENCE_DIR, 'phase2-evidence.json')],
      {
        cwd: join(HERE, '..'),
        stdio: 'ignore',
        timeout: 60_000,
      },
    )
    if (biome.status !== 0 && biome.error === undefined) {
      console.error('evidence: biome could not format the artifact (format:check will fail)')
    }
    const passed = assertions.filter((a) => a.ok).length
    console.log(
      `phase2 evidence: ${passed}/${assertions.length} assertions passed (see evidence/phase2-evidence.json)`,
    )
    return artifact.allPassed ? 0 : 1
  } catch (error) {
    console.error(
      `phase2 evidence failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    console.error(`transcript so far:\n${JSON.stringify(transcript, null, 2)}`)
    return 1
  } finally {
    rmSync(labHome, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
  }
}

/** Kill one spawned dsh process group. */
function killPid(pid) {
  if (pid === undefined) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
  } catch {
    // already gone
  }
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL')
    else process.kill(-pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

process.exitCode = await main()
