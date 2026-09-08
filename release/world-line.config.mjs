/**
 * Release configuration for `@seaveyon/dsh-world-line`.
 *
 * Identical in structure to `web-login.config.mjs` and deliberately not shared
 * with it: the two differ in exactly the fields a mistake would be invisible in
 * — the directory, the tag prefix, and the changelog path — so a factory that
 * generated both from a name would hide the one thing worth reading.
 *
 * @module release/world-line.config
 */

const directory = 'packages/world-line'

export default {
  branches: ['main'],
  tagFormat: 'world-line-v${version}',
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
          'chore(release): world-line ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
}
