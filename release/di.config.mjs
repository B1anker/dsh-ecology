/**
 * Release configuration for `@seaveyon/dsh-di`.
 *
 * Same shape as the other packages' configs (see `web-login.config.mjs` for
 * why the tag is scoped and why `scoped-commits` is load-bearing). Wired into
 * `.github/workflows/publish.yml` ahead of every plugin, because the plugins
 * declare this package as a production dependency and must not reach the
 * registry before the container version they name. That line fails until the
 * package's first version has been published by hand and tagged `di-v0.1.0` —
 * see README → "Bootstrapping a new package on npm" — which is deliberate: a
 * blocked release is recoverable, a plugin on the registry whose dependency is
 * not is broken for everyone who installs it.
 *
 * @module release/di.config
 */

const directory = 'packages/di'

export default {
  branches: ['main'],
  tagFormat: 'di-v${version}',
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
        message: 'chore(release): di ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
}
