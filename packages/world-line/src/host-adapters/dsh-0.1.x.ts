/**
 * The first host adapter: the DSH 0.1.2-rc.1 contract generation.
 *
 * Every constant below was taken from a real DSH 0.1.2-rc.1 installation and
 * exercised against a real temporary profile (see docs/compatibility.md and
 * the evidence/ artifacts):
 *
 * - `dsh --version` → `0.1.2-rc.1`
 * - `@deepseek-ai/dsh-home-paths` 0.1.2-rc.1: home = explicit > `$DSH_HOME` >
 *   `~/.dsh`; profiles live under `<home>/profiles`.
 * - `@deepseek-ai/dsh-app-boot` 0.1.2-rc.1 (`profile.js` / `index.js`):
 *   profile manifest `package.json` carries `dsh.profile.bundles` (ordered)
 *   and optional `patchReload`; `cordis.patch.yml` is the user layer;
 *   `cordis.yml` is the derived root config that `prepareProfile` rewrites on
 *   every boot to the exact PROFILE_ROOT_CONFIG below; shipped templates for
 *   `web`/`acp`/`headless`/`sdk`/`sdk-minimal`; default bundles `dsh-base`;
 *   patch files are a top-level YAML array of loader patch entries whose
 *   dialect registers the `!!js` scalar tag over the JSON schema.
 *
 * Policy (invariant 7): only the exact exercised versions are `known`; any
 * other version keeps doctor/snapshot (read-only) available and blocks
 * guessing-parameter commands (labs/promotion, Phase 2+).
 */

import type { DshVersion, HostAdapter, VersionVerdict } from './types.js'

/** Canonical root config `prepareProfile` writes; quoted verbatim from 0.1.2-rc.1. */
const ROOT_CONFIG_TEMPLATE = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Shipped profile templates (dsh-app-boot 0.1.2-rc.1 PROFILE_TEMPLATES). */
const TEMPLATES = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' },
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    patchReload: 'startup',
  },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
} as const

/**
 * The DSH 0.1.2-rc.1 adapter.
 */
export const adapterDsh01x: HostAdapter = {
  id: 'dsh-0.1.x',
  testedVersions: ['0.1.2-rc.1'],
  profile: {
    profilesDirName: 'profiles',
    rootConfigFilename: 'cordis.yml',
    rootConfigTemplate: ROOT_CONFIG_TEMPLATE,
    patchFilename: 'cordis.patch.yml',
    workspaceFilename: 'pnpm-workspace.yaml',
    lockFilenames: ['pnpm-lock.yaml'],
    templates: TEMPLATES,
    defaultBundles: ['@deepseek-ai/dsh-base'],
  },
  verdict(version: DshVersion | null, undetectable = false): VersionVerdict {
    if (undetectable || version === null) {
      return {
        version,
        undetectable,
        known: false,
        reason: undetectable
          ? 'dsh --version did not answer; refusing every version-sensitive operation'
          : 'dsh --version output carried no semver; refusing every version-sensitive operation',
      }
    }
    const exact = `${version.core.major}.${version.core.minor}.${version.core.patch}${
      version.prerelease === null ? '' : `-${version.prerelease}`
    }`
    if (this.testedVersions.includes(exact)) {
      return {
        version,
        undetectable: false,
        known: true,
        reason: `${exact} matches the exercised evidence set of adapter ${this.id}`,
      }
    }
    return {
      version,
      undetectable: false,
      known: false,
      reason:
        `${exact} was not exercised against adapter ${this.id} (tested: ` +
        `${this.testedVersions.join(', ')}); read-only doctor/snapshot stay ` +
        `available, version-sensitive operations fail closed`,
    }
  },
}

// ---------------------------------------------------------------------------
// Phase 2 launch / compose argv builders (WORLD-LINE-SPEC §8: version-sensitive
// facts live in the adapter). Every shape below was exercised against a real
// DSH 0.1.2-rc.1 in a temp home (see docs/phase2-design.md):
//
//   boot:  dsh --profile <name> --port 0 --no-open      → ready line on stdout:
//          `dsh web: http://127.0.0.1:<port>/?token=…` (printed only after the
//          loader settled and webServer/connection exist).
//   dump:  dsh --profile <name> --dump-config [--patch <p>]  → composed YAML.
//   plugin: dsh plugin --profile <name> <pnpm args…>    → real pnpm forwarder
//          running in the profile dir; reconciles dsh.profile.bundles from
//          installed state after a successful run.
// ---------------------------------------------------------------------------

/** Web-app boot argv: OS-picked loopback port, never auto-open a browser. */
export function dshBootArgs(profileName: string, port: number): string[] {
  return ['--profile', profileName, '--port', String(port), '--no-open']
}

/** First stdout line of a successful web boot starts with this prefix. */
export const DSH_WEB_READY_PREFIX = 'dsh web: http'

/** Compose argv; optional overlay is applied after the profile patch layer. */
export function dshDumpArgs(profileName: string, overlayPath?: string | null): string[] {
  const args = ['--profile', profileName, '--dump-config']
  if (overlayPath !== undefined && overlayPath !== null) args.push('--patch', overlayPath)
  return args
}

/** `dsh plugin` argv forwarding one pnpm invocation to a profile dir. */
export function dshPluginArgs(profileName: string, pnpmArgs: readonly string[]): string[] {
  return ['plugin', '--profile', profileName, ...pnpmArgs]
}
