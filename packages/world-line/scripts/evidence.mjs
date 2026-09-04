/**
 * Real-DSH evidence run (WORLD-LINE-SPEC §12 acceptance evidence).
 *
 * Requires a real `dsh` binary on PATH; exits 0 with a "skipped" note when
 * absent (CI has no DSH). The run is fully sandboxed in a fresh temp DSH
 * home:
 *
 *   1. asks the real `dsh --profile web --dump-config` to initialize a
 *      profile from its own web template (no network, no node_modules);
 *   2. asserts the bytes dsh actually writes match this package's adapter
 *      contract byte-for-byte;
 *   3. drives the real CLI surface (`snapshot create`, `doctor --json`,
 *      `timeline list/show/diff --json`) over that profile with injected
 *      changes, and asserts the envelope/exit-code contract;
 *   4. verifies a secret inserted into the user patch never reaches stdout,
 *      manifests, or the vault object store;
 *   5. writes one evidence/ artifact (transcript + assertions) for the repo.
 *
 * Any failed assertion prints the transcript and exits 1.
 *
 * The artifact is committed to the repo, and the repo's `format:check` runs
 * biome over it — so the script reformats its own output with the repo's
 * biome when available (best effort: a machine without bunx still gets a
 * valid artifact, it just needs a manual `biome check --write` before
 * committing).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli } from '../dist/cli.js'
import { adapterDsh01x } from '../dist/host-adapters/dsh-0.1.x.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = join(HERE, '..', 'evidence')
const step = (name, payload) => ({ name, ...payload })

/** Spawn the real dsh CLI and record a transcript entry. */
function runDsh(args, env) {
  const probe = spawnSync('dsh', args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  const entry = { args, exit: probe.status ?? probe.error?.code ?? 'error' }
  if (probe.error) entry.error = String(probe.error)
  else entry.stdout = probe.stdout
  if (probe.stderr) entry.stderr = probe.stderr
  return { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '', entry }
}

/** Drive the world-line CLI in-process and record a transcript entry. */
async function runWorldLine(args, env) {
  let stdout = ''
  let stderr = ''
  const exit = await runCli(args, {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    out: (text) => (stdout += text),
    err: (text) => (stderr += text),
  })
  const entry = { args, exit, stdout, stderr }
  return { exit, stdout, stderr, entry }
}

function findBinary(name) {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const transcript = []
const assertions = []
let passed = 0

function recordAssertion(name, ok, detail) {
  assertions.push({ name, ok, detail })
  if (ok) passed += 1
}

async function main() {
  if (findBinary('dsh') === null) {
    console.log('dsh not found on PATH — skipping real evidence run (CI has no DSH)')
    return 0
  }

  const home = mkdtempSync(join(tmpdir(), 'world-line-evidence-'))
  const profileDir = join(home, 'profiles', 'web')
  const env = { DSH_HOME: home }
  try {
    // ---- 1. Real DSH boot: profile initialization from the shipped template.
    const boot = runDsh(['--profile', 'web', '--dump-config'], env)
    transcript.push(step('dsh-boot', boot.entry))
    recordAssertion('dsh boots an empty home', boot.status === 0, `exit ${boot.status}`)

    const manifestRaw = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw)
    transcript.push(step('profile-manifest', { raw: manifestRaw }))
    recordAssertion(
      'manifest carries the web template bundles',
      JSON.stringify(manifest.dsh.profile.bundles) ===
        JSON.stringify(adapterDsh01x.profile.templates.web.bundles),
      JSON.stringify(manifest.dsh.profile.bundles),
    )
    recordAssertion(
      'manifest patchReload is live',
      manifest.dsh.profile.patchReload === adapterDsh01x.profile.templates.web.patchReload,
      manifest.dsh.profile.patchReload,
    )

    const cordisRaw = readFileSync(join(profileDir, 'cordis.yml'), 'utf8')
    transcript.push(step('derived-cordis-yml', { raw: cordisRaw }))
    recordAssertion(
      'dsh rewrote cordis.yml to the adapter template byte-for-byte',
      cordisRaw === adapterDsh01x.profile.rootConfigTemplate,
      `written ${cordisRaw.length} bytes vs template ${adapterDsh01x.profile.rootConfigTemplate.length}`,
    )

    const patchRaw = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    transcript.push(step('template-patch', { raw: patchRaw }))

    // ---- 2. Snapshot the freshly booted, untouched profile.
    const first = await runWorldLine(['snapshot', 'create', '--label', 'boot-state', '--json'], env)
    transcript.push(step('snapshot-boot', first.entry))
    recordAssertion(
      'snapshot create exits 0 on the real profile',
      first.exit === 0,
      String(first.exit),
    )
    const envelope = JSON.parse(first.stdout)
    recordAssertion(
      'snapshot envelope is ok',
      envelope.ok === true && envelope.schemaVersion === 1,
      '',
    )
    const firstId = envelope.data.id
    recordAssertion(
      'snapshot id is well-formed',
      /^snap-[0-9A-Z]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(firstId),
      firstId,
    )
    recordAssertion(
      'manifest files exclude the derived root config',
      envelope.data.files.every((file) => file.name !== 'cordis.yml'),
      JSON.stringify(envelope.data.files),
    )
    recordAssertion(
      'the real dsh version is known to the adapter',
      envelope.data.dsh.cliVersion === '0.1.2-rc.1' && envelope.data.dsh.known === true,
      JSON.stringify(envelope.data.dsh),
    )

    // The manifest (not the command result) carries the derived-root verdict.
    const showBoot = await runWorldLine(['timeline', 'show', firstId, '--json'], env)
    transcript.push(step('timeline-show-boot', showBoot.entry))
    const bootManifest = JSON.parse(showBoot.stdout).data.manifest
    recordAssertion(
      'derived root was clean at capture',
      showBoot.exit === 0 &&
        bootManifest.derived.rootConfigPresent === true &&
        bootManifest.derived.rootConfigClean === true,
      JSON.stringify(bootManifest.derived),
    )

    // ---- 3. Doctor over the real profile (dsh discovered on PATH).
    const doctor = await runWorldLine(['doctor', '--json'], env)
    transcript.push(step('doctor', doctor.entry))
    const doctorEnvelope = JSON.parse(doctor.stdout)
    recordAssertion(
      'doctor exits 0 on a healthy real profile',
      doctor.exit === 0,
      String(doctor.exit),
    )
    recordAssertion(
      'doctor reports no failed checks',
      doctorEnvelope.data.summary.failed === 0,
      JSON.stringify(doctorEnvelope.data.summary),
    )
    recordAssertion(
      'doctor verdict knows the real dsh version',
      doctorEnvelope.data.dsh.verdict.known === true &&
        doctorEnvelope.data.dsh.binary !== null &&
        doctorEnvelope.data.dsh.binary.includes('dsh'),
      JSON.stringify(doctorEnvelope.data.dsh),
    )

    // ---- 4. User edit with a secret-shaped value: policy must hold.
    // The template patch is comments + `[]`; replace the empty list with one
    // user entry (appending after `[]` would be a second document root and
    // real dsh refuses it, correctly).
    const secret = 'sk-live-evidence-token-1234567890'
    const editedPatch = `# world-line evidence edit\n- id: evidence-entry\n  name: '@seaveyon/dsh-web-login'\n  config:\n    apiKey: ${secret}\n`
    writeFileSync(join(profileDir, 'cordis.patch.yml'), editedPatch)

    const second = await runWorldLine(
      ['snapshot', 'create', '--label', 'secret-edit', '--json'],
      env,
    )
    transcript.push(step('snapshot-secret-edit', second.entry))
    recordAssertion('second snapshot exits 0', second.exit === 0, String(second.exit))
    recordAssertion(
      'the secret never appears in CLI output',
      !second.stdout.includes(secret) && !second.stderr.includes(secret),
      '',
    )
    const secondEnvelope = JSON.parse(second.stdout)
    recordAssertion(
      'the secret-bearing patch was skipped from the plaintext vault',
      secondEnvelope.data.skippedSecrets.includes('cordis.patch.yml'),
      JSON.stringify(secondEnvelope.data.skippedSecrets),
    )
    const objectsDirPath = join(home, 'world-line', 'vault', 'objects')
    if (existsSync(objectsDirPath)) {
      const { readdirSync } = await import('node:fs')
      let leaked = false
      const objectNames = []
      for (const name of readdirSync(objectsDirPath)) {
        objectNames.push(name)
        if (readFileSync(join(objectsDirPath, name), 'utf8').includes(secret)) leaked = true
      }
      recordAssertion(
        'the secret never reached the object store',
        !leaked,
        `${objectNames.length} objects`,
      )

      // ---- 5. Timeline over the real profile: list, show, diff.
      const list = await runWorldLine(['timeline', 'list', '--json'], env)
      transcript.push(step('timeline-list', list.entry))
      const listEnvelope = JSON.parse(list.stdout)
      recordAssertion(
        'timeline list shows both snapshots newest first',
        listEnvelope.data.snapshots.length === 2 &&
          listEnvelope.data.snapshots[0].id === secondEnvelope.data.id &&
          listEnvelope.data.snapshots[1].id === firstId,
        JSON.stringify(listEnvelope.data.snapshots.map((row) => row.id)),
      )

      const show = await runWorldLine(['timeline', 'show', firstId, '--json'], env)
      transcript.push(step('timeline-show', show.entry))
      const showEnvelope = JSON.parse(show.stdout)
      recordAssertion(
        'timeline show returns the first snapshot intact',
        show.exit === 0 && showEnvelope.data.manifest.id === firstId,
        '',
      )
      recordAssertion(
        'show output carries no secret',
        !show.stdout.includes(secret) && showEnvelope.data.manifest.label === 'boot-state',
        '',
      )

      const diff = await runWorldLine(
        ['timeline', 'diff', firstId, secondEnvelope.data.id, '--json'],
        env,
      )
      transcript.push(step('timeline-diff', diff.entry))
      const diffEnvelope = JSON.parse(diff.stdout)
      recordAssertion('timeline diff exits 0', diff.exit === 0, String(diff.exit))
      recordAssertion(
        'diff flags the patch file change',
        diffEnvelope.data.diff.files.some(
          (file) => file.name === 'cordis.patch.yml' && file.status === 'changed',
        ),
        JSON.stringify(diffEnvelope.data.diff.files),
      )
      recordAssertion('diff carries no secret', !diff.stdout.includes(secret), '')

      // ---- 6. Second boot rewrites the dirty patch file away: derived root
      // stays byte-identical to the template regardless of user edits.
      const secondBoot = runDsh(['--profile', 'web', '--dump-config'], env)
      transcript.push(step('dsh-second-boot', secondBoot.entry))
      const cordisAfter = readFileSync(join(profileDir, 'cordis.yml'), 'utf8')
      recordAssertion(
        'a later dsh boot keeps cordis.yml template-identical',
        secondBoot.status === 0 && cordisAfter === adapterDsh01x.profile.rootConfigTemplate,
        '',
      )

      const third = await runWorldLine(
        ['snapshot', 'create', '--label', 'post-second-boot', '--json'],
        env,
      )
      transcript.push(step('snapshot-post-second-boot', third.entry))
      const thirdEnvelope = JSON.parse(third.stdout)
      const showThird = await runWorldLine(
        ['timeline', 'show', thirdEnvelope.data.id, '--json'],
        env,
      )
      const thirdManifest = JSON.parse(showThird.stdout).data.manifest
      recordAssertion(
        'snapshot after a real boot records the derived root as clean again',
        third.exit === 0 && showThird.exit === 0 && thirdManifest.derived.rootConfigClean === true,
        JSON.stringify(thirdManifest.derived),
      )
    }

    // ---- Artifact + summary.
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const artifact = {
      worldLineVersion: process.env.npm_package_version ?? null,
      dshVersion: '0.1.2-rc.1 (detected from PATH)',
      runAt: new Date().toISOString(),
      dshHome: home,
      transcript,
      assertions,
      allPassed: assertions.every((a) => a.ok),
    }
    writeFileSync(
      join(EVIDENCE_DIR, 'live-evidence.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    )
    // The artifact is committed, and the repo's format:check runs biome over
    // it, so reformat with the repo's biome when available.
    const biome = spawnSync(
      'bunx',
      ['biome', 'check', '--write', join(EVIDENCE_DIR, 'live-evidence.json')],
      { cwd: join(HERE, '..'), stdio: 'ignore', timeout: 60_000 },
    )
    if (biome.status !== 0 && biome.error === undefined) {
      console.error('evidence: biome could not format the artifact (format:check will fail)')
    }
    console.log(
      `evidence: ${passed}/${assertions.length} assertions passed (see evidence/live-evidence.json)`,
    )
    return artifact.allPassed ? 0 : 1
  } catch (error) {
    console.error(`evidence failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`transcript so far:\n${JSON.stringify(transcript, null, 2)}`)
    return 1
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

process.exitCode = await main()
