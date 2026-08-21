/**
 * Validate this workspace's installable Web-login bundle without booting DSH.
 *
 * This is intentionally separate from `npm pack --dry-run`: npm will happily
 * pack a manifest whose `dsh.bundle.patch` names a file that is not in the
 * tarball, and it does not know that Loader patch fields replace whole values.
 * The fixture below encodes the four route-owner rows in the rc.7/rc.8 Web
 * profile, then applies the same field-replacement subset this bundle uses.
 *
 * A real `dsh --dump-config` remains the stronger compatibility test. This
 * check is the fast, dependency-light release gate that catches a missing
 * manifest, malformed YAML, lost Web dependency, or accidental old-style
 * `plugins:` mapping in every checkout.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const root = new URL('../packages/web-login/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

/** Refuse with one release-oriented diagnostic. */
function assert(condition, message) {
  if (!condition) throw new Error(`web-login bundle: ${message}`)
}

assert(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'unexpected dsh.bundle.patch')
assert(manifest.files?.includes('cordis.patch.yml'), 'cordis.patch.yml is absent from files')
assert(
  manifest.exports?.['./cordis.patch.yml'] === './cordis.patch.yml',
  'cordis.patch.yml is absent from exports',
)

const patchPath = join(fileURLToPath(root), manifest.dsh.bundle.patch)
const source = await readFile(patchPath, 'utf8')
const patches = load(source)
assert(Array.isArray(patches), 'patch must be a top-level YAML array')

const initial = [
  {
    id: 'web-runtime',
    name: '@deepseek-ai/dsh-web-app',
    inject: ['webStartup'],
    config: { printUrl: true, surfaceContext: true, trustedHosts: 'fixture-expression' },
  },
  {
    id: 'connection',
    name: '@deepseek-ai/dsh-client-connection',
    inject: ['webRuntime'],
    config: { trustedHosts: 'fixture-expression' },
  },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
]

const rows = structuredClone(initial)
const byId = new Map(rows.map((row) => [row.id, row]))
for (const patch of patches) {
  assert(typeof patch === 'object' && patch !== null, 'every patch entry must be a mapping')
  if (Array.isArray(patch.insert)) {
    for (const row of patch.insert) {
      rows.push(structuredClone(row))
      if (typeof row.id === 'string') byId.set(row.id, rows.at(-1))
    }
    continue
  }
  assert(typeof patch.id === 'string', 'a non-insert patch is missing id')
  const target = byId.get(patch.id)
  assert(target !== undefined, `patch targets unknown row ${patch.id}`)
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'id' && key !== 'name') target[key] = structuredClone(value)
  }
}

const expectedInject = {
  'web-runtime': ['webStartup', 'dshWebLoginReady'],
  connection: ['webRuntime', 'dshWebLoginReady'],
  modules: ['dshWebLoginReady'],
  'client-hmr': ['dshWebLoginReady'],
}
for (const [id, expected] of Object.entries(expectedInject)) {
  const actual = byId.get(id)?.inject
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${id} inject is ${JSON.stringify(actual)}`,
  )
}

for (const original of initial) {
  assert(
    JSON.stringify(byId.get(original.id)?.config) === JSON.stringify(original.config),
    `${original.id} config changed while adding readiness`,
  )
}

const login = byId.get('dsh-web-login')
assert(
  login?.name === '@seaveyon/dsh-web-login',
  'plugin row is missing or names the wrong package',
)
assert(
  JSON.stringify(login.inject) === JSON.stringify(['webServer']),
  'plugin row must wait for webServer',
)
assert(login.config?.secureCookie === true, 'bundle must fail secure by default')

console.log('ok    web-login bundle manifest, YAML, row insert, and readiness injections')
