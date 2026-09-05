/**
 * Release configuration for `@seaveyon/dsh-pet`.
 *
 * One file per package, run one at a time from the repository root — see
 * `release/web-login.config.mjs` for why the tag format is scoped to the
 * package and why `scoped-commits` is what makes per-package versioning real.
 *
 * @module release/pet.config
 */

const directory = 'packages/pet'

export default {
  branches: ['main'],
  tagFormat: 'pet-v${version}',
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
        // The platform manifests carry the same version stamp (the publish
        // workflow bumps them alongside pet's), so the release commit has to
        // record them or the checkout drifts from what was published.
        assets: [
          `${directory}/package.json`,
          `${directory}/CHANGELOG.md`,
          'packages/pet-desktop-darwin-arm64/package.json',
          'packages/pet-desktop-darwin-x64/package.json',
          'packages/pet-desktop-win32-x64/package.json',
        ],
        message: 'chore(release): pet ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
}
