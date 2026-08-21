/**
 * Check the plugin's hand-written host types against the real host packages.
 *
 * `packages/web-login/src/types.ts` declares the dsh `webServer` service and the
 * Cordis context structurally, by hand, because both are optional peers and the
 * targeted host version is not on the public registry. That is the right call —
 * see the comment at the top of that file — but it has a cost: nothing notices
 * when the host changes. The compatibility contract is a comment, and comments
 * do not fail builds.
 *
 * This is the part of that gap that can be closed without the packages being
 * installed everywhere. When they are absent it explains what was not checked
 * and exits successfully; when they are present it fails loudly if a member the
 * plugin binds to has disappeared from the host's own declarations.
 *
 * It is a smoke check, not a type check. Proving assignability needs the real
 * types in the compiler, which needs the package; proving a member still exists
 * only needs its declarations, which is what this reads.
 *
 * Usage: node scripts/check-host-contract.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * What the plugin binds to, and where each requirement comes from.
 *
 * Every entry here is load-bearing: `src/index.ts` replaces the three registry
 * members, and route owners depend on `provide` publishing the readiness
 * service.
 */
const CONTRACT = [
  {
    package: '@deepseek-ai/dsh-host-webserver',
    members: ['register', 'registerUpgrade', 'registerFallback'],
    why: 'the gate wraps all three to guard routes registered after it loads',
  },
  {
    package: '@deepseek-ai/cordis',
    members: ['effect', 'provide'],
    why: 'disposal and the dshWebLoginReady readiness service depend on them',
  },
]

const require = createRequire(import.meta.url)

/**
 * Locate an installed package's directory.
 * @param name - the package name.
 * @returns the directory, or null when the package is not installed.
 */
function resolvePackage(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

/**
 * Collect the text of every declaration file under a directory.
 * @param root - directory to walk.
 * @returns the concatenated contents.
 */
async function readDeclarations(root) {
  const parts = []
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        await walk(path)
      } else if (entry.name.endsWith('.d.ts')) {
        parts.push(await readFile(path, 'utf8'))
      }
    }
  }
  await walk(root)
  return parts.join('\n')
}

let checked = 0
let failed = false

for (const entry of CONTRACT) {
  const root = resolvePackage(entry.package)
  if (root === null) {
    console.log(`skip  ${entry.package} is not installed; its contract was not verified`)
    continue
  }

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const declarations = await readDeclarations(root)
  if (declarations === '') {
    console.log(`skip  ${entry.package}@${manifest.version} ships no declarations to read`)
    continue
  }

  checked += 1
  const missing = entry.members.filter(
    (member) => !new RegExp(`\\b${member}\\b`).test(declarations),
  )
  if (missing.length === 0) {
    console.log(`ok    ${entry.package}@${manifest.version} declares ${entry.members.join(', ')}`)
    continue
  }

  failed = true
  console.error(
    `FAIL  ${entry.package}@${manifest.version} no longer declares ${missing.join(', ')}\n` +
      `      ${entry.why}\n` +
      '      Update packages/web-login/src/types.ts and the tested-version notes ' +
      'in README.md and SECURITY.md.',
  )
}

if (checked === 0) {
  console.log(
    '\nNothing to check. Both host packages are optional peers, and the targeted\n' +
      'version is not on the public registry, so this is the expected result in a\n' +
      'normal checkout. Install them alongside the workspace to make this check real.',
  )
}

process.exit(failed ? 1 : 0)
