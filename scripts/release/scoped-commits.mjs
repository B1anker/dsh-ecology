/**
 * A semantic-release plugin that only sees one package's commits.
 *
 * Everything in this workspace is versioned independently, but semantic-release
 * has one notion of "the commits since the last tag" and it is the whole branch.
 * With a single package that difference is invisible. With two it is a bug that
 * ships: a `feat:` touching only the testkit would release a new minor of the
 * login gate, whose code did not change, and the release notes would describe
 * work that is not in the tarball.
 *
 * This wraps the two plugins that read commits — the analyzer that decides the
 * bump, and the generator that writes the notes — and hands each of them the
 * subset of commits that touched the configured directory. Every other plugin in
 * the pipeline is unaffected, because none of the others cares which commits
 * exist; they care about the version the analyzer produced.
 *
 * Configure it in place of `@semantic-release/commit-analyzer` and
 * `@semantic-release/release-notes-generator`:
 *
 * ```json
 * ["./scripts/release/scoped-commits.mjs", { "directory": "packages/web-login" }]
 * ```
 *
 * Any other option is forwarded to both wrapped plugins unchanged, so their
 * `preset`, `releaseRules`, and the rest keep working.
 *
 * @module scripts/release/scoped-commits
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { analyzeCommits as analyze } from '@semantic-release/commit-analyzer'
import { generateNotes as generate } from '@semantic-release/release-notes-generator'

const run = promisify(execFile)

/**
 * Read the paths a commit touched.
 *
 * One `git show` per commit. That is the slow way, and it is fast enough: the
 * list is the commits since a package's last tag, which is small — except on a
 * first release, which reads the whole history once and then never again.
 *
 * A merge commit reports no paths here, because `git show` prints no file list
 * for one without an explicit diff mode. That is the behaviour we want: the
 * changes a merge brings in arrive as the commits it merges, and counting them
 * twice would double every release note.
 *
 * @param hash - the commit to inspect.
 * @param cwd - the repository root.
 * @returns repository-relative paths, possibly empty.
 */
async function pathsIn(hash, cwd) {
  const { stdout } = await run('git', ['show', '--pretty=format:', '--name-only', hash], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.split('\n').filter((line) => line !== '')
}

/**
 * Narrow the context to commits touching the configured directory.
 * @param pluginConfig - this plugin's options; `directory` is required.
 * @param context - the semantic-release context.
 * @returns a context whose `commits` are the relevant ones.
 */
async function scope(pluginConfig, context) {
  const { directory } = pluginConfig
  if (typeof directory !== 'string' || directory === '') {
    throw new Error('scoped-commits: a `directory` option is required')
  }
  const prefix = directory.endsWith('/') ? directory : `${directory}/`
  const cwd = context.cwd ?? process.cwd()

  const kept = []
  for (const commit of context.commits ?? []) {
    const paths = await pathsIn(commit.hash, cwd)
    if (paths.some((path) => path.startsWith(prefix))) kept.push(commit)
  }

  context.logger.log(
    `scoped-commits: ${kept.length} of ${(context.commits ?? []).length} commits touch ${directory}`,
  )
  return { ...context, commits: kept }
}

/**
 * Decide the release type from this package's commits alone.
 * @param pluginConfig - `directory`, plus any commit-analyzer option.
 * @param context - the semantic-release context.
 * @returns the release type, or null when these commits imply none.
 */
export async function analyzeCommits(pluginConfig, context) {
  return analyze(pluginConfig, await scope(pluginConfig, context))
}

/**
 * Write release notes from this package's commits alone.
 * @param pluginConfig - `directory`, plus any release-notes-generator option.
 * @param context - the semantic-release context.
 * @returns the notes.
 */
export async function generateNotes(pluginConfig, context) {
  return generate(pluginConfig, await scope(pluginConfig, context))
}
