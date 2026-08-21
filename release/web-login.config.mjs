/**
 * Release configuration for `@seaveyon/dsh-web-login`.
 *
 * One file per package, run one at a time from the repository root:
 *
 * ```sh
 * bunx semantic-release --extends ./release/web-login.config.mjs
 * ```
 *
 * The tag format is scoped to the package rather than the repository, because
 * the packages here are versioned independently and a bare `v1.2.3` would be a
 * claim about all of them. The scoped tag is also what makes the *next* release
 * correct: semantic-release finds the last release by matching this pattern, so
 * a tag naming another package is invisible here, as it should be.
 *
 * `scoped-commits` is what makes independence real rather than nominal. Without
 * it every plugin below would see the whole branch, and a commit touching only
 * another package would bump this one and appear in its notes.
 *
 * @module release/web-login.config
 */

const directory = 'packages/web-login'

export default {
  branches: ['main'],
  tagFormat: 'web-login-v${version}',
  plugins: [
    ['./scripts/release/scoped-commits.mjs', { directory }],
    ['@semantic-release/changelog', { changelogFile: `${directory}/CHANGELOG.md` }],
    [
      '@semantic-release/exec',
      { prepareCmd: `node scripts/bump-version.mjs ${directory} \${nextRelease.version}` },
    ],
    [
      '@semantic-release/git',
      {
        assets: [`${directory}/package.json`, `${directory}/CHANGELOG.md`],
        message:
          'chore(release): web-login ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
}
