#!/usr/bin/env bun

/**
 * Real-host end-to-end evidence for the Phase 3 milestone
 * (packages/world-line): browser client probes + promotion against a temp
 * DSH home, real dsh 0.1.x and (when present) real Google Chrome:
 *
 *  1. fresh-home bootstrap, empty lab list,
 *  2. `lab add file:… --promote` (no --keep): full §6 browser client probes
 *     in a fresh Playwright context; clientReady gate PASS; auto
 *     pre/post-promote snapshots; journal `committed`; official package.json
 *     now carries the candidate; success lab auto-deleted,
 *  3. `lab add file:… --promote --restart`: boot the official profile,
 *     re-probe the client shell; after-snapshot becomes lastKnownGood,
 *  4. client-browser made unavailable (PLAYWRIGHT_CHROMIUM_EXECUTABLE
 *     pointing at nothing): promotion-bound run yields no reliable signal →
 *     refused (exit 1); the same spec with --accept-inconclusive commits.
 *
 * Requires: real dsh + pnpm on PATH, a `bun run build`, and Chrome for steps
 * 2-3. Steps degrade: missing Chrome runs the inconclusive-gate assertions
 * only; missing dsh/pnpm skips entirely (exit 0 with a note) so CI — which
 * has none — stays green. Offline: the only candidate is a synthetic
 * `file:` plugin.
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

const assertions = []
const record = (name, ok, detail = '') => {
  assertions.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? ` — ${detail}` : ''}`)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: PKG,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, ...opts.env },
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })
  return { exit: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function bootOnce(home, profile) {
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
      const match = READY_RE.exec(stdout.split('\n').find((l) => READY_RE.test(l)) ?? '')
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
    const timer = setTimeout(() => finish({ timedOut: true, stdout, stderr }), 120_000)
  })
}

function cli(home, args, extraEnv = {}) {
  return run('node', [CLI, '--dsh-home', home, ...args], {
    env: { DSH_HOME: home, ...extraEnv },
  })
}

function haveOnPath(name) {
  return run('sh', ['-lc', `command -v ${name}`], { cwd: PKG }).stdout.trim() !== ''
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hasChrome = existsSync(CHROME)

function writePlugin(dir, name = '@fixture/world-line-phase3-probe') {
  mkdirSync(dir, { recursive: true })
  const id = name.replace('@', '').replace('/', '-')
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
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
    `export const name = ${JSON.stringify(name)}\nexport function apply(ctx) { ctx.logger?.('probe').info('applied') }\n`,
  )
  writeFileSync(
    join(dir, 'cordis.patch.yml'),
    `- insert:\n    - id: ${id}\n      name: ${JSON.stringify(name)}\n`,
  )
}

function journalEntries(home) {
  const path = join(home, 'world-line', 'journal.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function officialPackage(home) {
  return JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
}

async function main() {
  if (!existsSync(join(PKG, 'dist/index.js'))) {
    console.error('phase3 evidence: dist build missing — run `bun run build` first')
    return 1
  }
  const dsh = haveOnPath('dsh')
  const pnpm = haveOnPath('pnpm')
  if (!dsh || !pnpm) {
    console.log(`phase3 evidence skipped: real dsh or pnpm not on PATH (dsh=${dsh}, pnpm=${pnpm})`)
    return 0
  }
  record('real dsh + pnpm on PATH', true, `dsh=${dsh} pnpm=${pnpm}`)
  record('Google Chrome available', hasChrome, hasChrome ? CHROME : 'degrading to gate-only')

  const home = mkdtempSync(join(tmpdir(), 'world-line-phase3-'))
  const pluginDir = mkdtempSync(join(tmpdir(), 'world-line-p3-plugin-'))
  const pluginDir2 = mkdtempSync(join(tmpdir(), 'world-line-p3-plugin2-'))
  const pluginDir3 = mkdtempSync(join(tmpdir(), 'world-line-p3-plugin3-'))
  try {
    const boot = await bootOnce(home, 'web')
    record(
      'real dsh booted a fresh DSH home and profile web',
      boot.url !== undefined && boot.error === undefined,
      boot.url === undefined
        ? String(boot.error ?? boot.exited ?? '')
        : 'listening on a loopback port',
    )
    await sleep(1200)

    const empty = cli(home, ['lab', 'list'])
    record('empty lab list exits 0', empty.exit === 0 && /no labs/.test(empty.stdout))

    // ---------------------------------------------------------------- 2. promote
    writePlugin(pluginDir)
    const promoted = cli(home, ['lab', 'add', `file:${pluginDir}`, '--promote'])
    const promotedLines = promoted.stdout.split('\n')
    const clientLine = promotedLines.find((line) => line.startsWith('client'))
    const filesLine = promotedLines.find((line) => line.startsWith('files'))
    record(
      'lab add file: --promote passes (exit 0)',
      promoted.exit === 0 && /promoted\s+yes/.test(promoted.stdout),
      `exit=${promoted.exit} ok=${/promoted\s+yes/.test(promoted.stdout)} ` +
        `stderr=${(promoted.stderr.split('\n')[0] ?? '').slice(0, 160)} ` +
        `head=${(promotedLines[0] ?? '').slice(0, 60)}`,
    )
    record(
      'client gate shows real browser probes',
      clientLine !== undefined && /browser client probes recorded/.test(clientLine ?? ''),
      clientLine ?? '(missing)',
    )
    record(
      'whitelist managed files swapped onto the official profile',
      filesLine !== undefined &&
        ['package.json', 'pnpm-lock.yaml'].every((name) => filesLine.includes(name)),
      filesLine ?? '(missing)',
    )
    record(
      'official package.json now declares the candidate',
      Object.keys(officialPackage(home).dependencies ?? {}).includes(
        '@fixture/world-line-phase3-probe',
      ),
      JSON.stringify(officialPackage(home).dependencies ?? {}),
    )
    const entries = journalEntries(home)
    record(
      'journal carries one committed promotion',
      entries.length === 1 &&
        entries[0].kind === 'promotion' &&
        entries[0].outcome === 'committed' &&
        !entries[0].lastKnownGood,
      JSON.stringify(entries.map((e) => e.outcome)),
    )
    const timeline = cli(home, ['timeline', 'list', '--json'])
    const snapshots = JSON.parse(timeline.stdout).data.snapshots ?? []
    const labels = snapshots.map((s) => s.label ?? '')
    record(
      'auto pre-promote + after snapshots recorded in the timeline',
      labels.some((l) => l.startsWith('pre-promote:')) &&
        labels.some((l) => l.startsWith('post-promote:')),
      labels.join(' | '),
    )
    const labsAfter = JSON.parse(cli(home, ['lab', 'list', '--json']).stdout).data.labs
    record(
      'successful promote cleans the lab up by default',
      labsAfter.length === 0,
      JSON.stringify(labsAfter.map((l) => l.state)),
    )

    // ------------------------------------------------- 4. inconclusive gate
    const noChromeEnv = { PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/nonexistent/chromium' }
    writePlugin(pluginDir3, '@fixture/world-line-phase3-gate')
    const refused = cli(home, ['lab', 'add', `file:${pluginDir3}`, '--promote'], noChromeEnv)
    record(
      'no reliable browser signal refuses promotion (exit 1)',
      refused.exit === 1,
      `exit=${refused.exit} stdout-first=${refused.stdout.split('\n')[0] ?? ''} ` +
        `stderr=${(refused.stderr.split('\n')[0] ?? '').slice(0, 120)}`,
    )
    const accepted = cli(
      home,
      ['lab', 'add', `file:${pluginDir3}`, '--promote', '--accept-inconclusive'],
      noChromeEnv,
    )
    const acceptedLine = accepted.stdout.split('\n').find((l) => l.startsWith('client'))
    record(
      '--accept-inconclusive lets the user accept the risk and commits',
      accepted.exit === 0 &&
        /inconclusive \(accepted/.test(acceptedLine ?? '') &&
        Object.keys(officialPackage(home).dependencies ?? {}).includes(
          '@fixture/world-line-phase3-gate',
        ),
      `exit=${accepted.exit} ${acceptedLine ?? ''}`,
    )
    record(
      'journal records the gate promotion so far',
      journalEntries(home).length === 2,
      String(journalEntries(home).length),
    )

    // ------------------------------------------------- 3. promote --restart
    if (hasChrome) {
      writePlugin(pluginDir2, '@fixture/world-line-phase3-restart')
      const restarted = cli(home, ['lab', 'add', `file:${pluginDir2}`, '--promote', '--restart'])
      record(
        'lab add --promote --restart passes with restart verification',
        restarted.exit === 0 && /restart\s+verified/.test(restarted.stdout),
        `exit=${restarted.exit} stderr=${(restarted.stderr.split('\n')[0] ?? '').slice(0, 160)} ` +
          restarted.stdout.split('\n').slice(0, 2).join(' | '),
      )
      const state = JSON.parse(readFileSync(join(home, 'world-line', 'state.json'), 'utf8'))
      const afterTimeline =
        JSON.parse(cli(home, ['timeline', 'list', '--json']).stdout).data.snapshots ?? []
      const latestId = afterTimeline[0]?.id
      record(
        'after-snapshot of the restarted promote is lastKnownGood',
        state.lastKnownGood?.web === latestId && latestId !== undefined,
        `lkg=${state.lastKnownGood?.web} latest=${latestId}`,
      )
      record(
        'journal now has a committed entry flagged lastKnownGood',
        journalEntries(home).some((e) => e.outcome === 'committed' && e.lastKnownGood),
        JSON.stringify(journalEntries(home).map((e) => e.lastKnownGood)),
      )
    }

    // ------------------------------------------------------------------ done
    const ok = assertions.every((entry) => entry.ok)
    const summary = {
      milestone: 'phase-3',
      generatedAt: new Date().toISOString(),
      prerequisites: { dsh, pnpm, chrome: hasChrome },
      ok,
      assertions,
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(
      join(EVIDENCE_DIR, 'phase3-evidence.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    )
    console.log(
      `\nphase3 evidence: ${ok ? 'ALL PASS' : 'FAILURES PRESENT'} — ` +
        `${assertions.filter((entry) => entry.ok).length}/${assertions.length} assertions`,
    )
    return ok ? 0 : 1
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(pluginDir, { recursive: true, force: true })
    rmSync(pluginDir2, { recursive: true, force: true })
    rmSync(pluginDir3, { recursive: true, force: true })
  }
}

await main()
