/**
 * Release configuration for `@seaveyon/dsh-git-worktree`.
 *
 * Same shape as the other packages' configs (see `web-login.config.mjs` for
 * why the tag is scoped and why `scoped-commits` is load-bearing). Not yet
 * wired into `.github/workflows/publish.yml`: the package's first version has
 * to be published by hand and tagged `git-worktree-v0.1.0` first — see README
 * → "Bootstrapping a new package on npm" — or semantic-release would read the
 * repository's whole history and the publish would fail on a package that has
 * no trusted publisher yet, aborting the packages after it in the same job.
 *
 * @module release/git-worktree.config
 */

const directory = 'packages/git-worktree'

export default {
  branches: ['main'],
  tagFormat: 'git-worktree-v${version}',
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
          'chore(release): git-worktree ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
}
