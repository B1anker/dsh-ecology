/**
 * Test fixture builders: a miniature DSH home + profile with the exact file
 * layout a real DSH 0.1.2-rc.1 profile has (see docs/compatibility.md), plus
 * an in-process CLI runner.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../../src/cli.js'

/** The canonical derived root config the host rewrites on every boot. */
export const CANONICAL_CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

export const CANONICAL_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Standard profile manifest for fixtures. */
export function profilePackageJson(
  options: {
    name?: string
    bundles?: string[]
    dependencies?: Record<string, string>
    patchReload?: string
  } = {},
): string {
  const manifest = {
    name: options.name ?? 'dsh-profile-web',
    private: true,
    dependencies: options.dependencies ?? {},
    dsh: {
      profile: {
        bundles: options.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        ...(options.patchReload !== undefined ? { patchReload: options.patchReload } : {}),
      },
    },
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Make a fresh temp DSH home for one test. */
export async function makeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wl-test-home-'))
}

/** Remove a temp home (best effort). */
export async function destroyTempHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}

/** Write the standard web profile fixture under `home/profiles/<name>`. */
export async function writeProfile(
  home: string,
  name: string,
  overrides: {
    packageJson?: string
    patchYaml?: string
    workspaceYaml?: string
    lockfile?: string
    cordisYml?: string
    extraTopLevel?: Record<string, string>
  } = {},
): Promise<string> {
  const dir = join(home, 'profiles', name)
  await mkdir(dir, { recursive: true })
  const files: Record<string, string> = {
    'package.json': overrides.packageJson ?? profilePackageJson(),
    'cordis.patch.yml':
      overrides.patchYaml ?? '- id: fixture-entry\n  config:\n    enabled: true\n',
    'pnpm-workspace.yaml': overrides.workspaceYaml ?? CANONICAL_PNPM_WORKSPACE,
    'cordis.yml': overrides.cordisYml ?? CANONICAL_CORDIS_YML,
  }
  if (overrides.lockfile !== undefined) files['pnpm-lock.yaml'] = overrides.lockfile
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(join(dir, relative), content)
  }
  for (const [relative, content] of Object.entries(overrides.extraTopLevel ?? {})) {
    await writeFile(join(dir, relative), content)
  }
  return dir
}

/** A lockfileVersion-9 pnpm lockfile for a single registry dependency. */
export function minimalLockfile(dependencyName: string, version: string): string {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      ${JSON.stringify(dependencyName)}:
        specifier: ${JSON.stringify(version)}
        version: ${version}

packages:
  ${JSON.stringify(`/${dependencyName}@${version}`)}:
    resolution:
      integrity: sha512-fakeintegrityfor${dependencyName}
      tarball: https://registry.example.com/${dependencyName}/-/${dependencyName}-${version}.tgz
    version: ${version}
`
}

/** Run the CLI in-process; returns exit code + collected output. */
export async function runCliIn(options: {
  argv: string[]
  home?: string
  env?: Record<string, string>
  cwd?: string
  now?: () => Date
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const exitCode = await runCli(options.argv, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, DSH_HOME: options.home, ...options.env } as NodeJS.ProcessEnv,
    now: options.now,
    out: (text: string) => {
      stdout += text
    },
    err: (text: string) => {
      stderr += text
    },
  })
  return { exitCode, stdout, stderr }
}
