/**
 * The `dsh-web-login-hash` command line.
 *
 * This is the one suite that tests a build artifact rather than a source module.
 * The CLI is a top-level-await script with no exported entry point — importing it
 * would run it — so it is exercised the way a user runs it: spawned as a child
 * process. Spawning `dist/hash-password.js` rather than the TypeScript source
 * also puts two build-time properties under test that no source-level test can
 * see, both of which have exactly one chance to be wrong:
 *
 *   - the shebang, which `rslib.config.ts` prepends via `banner.js` because a
 *     shebang written into the source would land mid-file in the output;
 *   - the executable bit, without which the `bin` entry fails at install time
 *     rather than in CI.
 *
 * @module test/unit/hash-password-cli
 */

import { spawn } from 'node:child_process'
import { access, constants, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, test } from '@rstest/core'

/** The built CLI, resolved from this file so the cwd cannot change the target. */
const CLI = fileURLToPath(new URL('../../dist/hash-password.js', import.meta.url))

/**
 * Fail with an instruction rather than an ENOENT from five separate tests.
 *
 * This suite is the only one with a build-order dependency. On a clean checkout
 * `dist/` does not exist yet, and the raw failure — a spawn ENOENT repeated per
 * test — says nothing about the cause.
 */
beforeAll(async () => {
  try {
    await access(CLI, constants.F_OK)
  } catch {
    throw new Error(
      `The built CLI is missing at ${CLI}.\n` +
        'This suite tests the build artifact; run `bun run build` first ' +
        '(`bun run pack:check` and CI both build before testing).',
    )
  }
})

/** What a finished child process leaves behind. */
interface Result {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run the built CLI to completion.
 *
 * stdin is closed rather than left open: every case here must terminate on its
 * own, and a CLI that decided to prompt would otherwise hang the suite instead
 * of failing it.
 *
 * @param args - arguments after the script name.
 * @returns the exit status and captured output.
 */
function run(args: readonly string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('the built CLI is an executable script the shell can run directly', async () => {
  // The `bin` entry in package.json points here. If either property is missing,
  // The package-manager-created `dsh-web-login-hash` bin fails for every user
  // and for nobody in CI if either property is wrong, because every other test
  // in this file spawns it through an explicit interpreter.
  const source = await readFile(CLI, 'utf8')
  expect(source.startsWith('#!/usr/bin/env node'), 'the build must prepend the shebang').toBe(true)

  await access(CLI, constants.X_OK)

  // The banner belongs to the CLI entry alone. rslib applies `banner.js` to
  // every file an entry emits, so a single combined entry would have put a
  // shebang on all eleven library modules — valid as a comment, wrong as an
  // advertisement that they are executables.
  const library = await readFile(new URL('../../dist/index.js', import.meta.url), 'utf8')
  expect(library.startsWith('#!'), 'library modules must not carry a shebang').toBe(false)
})

test('the CLI documents its arguments without requiring a TTY', async () => {
  const result = await run(['--help'])
  expect(result.code).toBe(0)
  expect(result.stdout).toMatch(/^Usage: dsh-web-login-hash/m)
  expect(result.stdout).toMatch(/--env-path <path>/)
  expect(result.stdout).toMatch(/--var <NAME>/)
  expect(result.stdout).toMatch(/--no-restart/)
  expect(result.stderr, 'help is not an error').toBe('')
})

test('the CLI refuses bad arguments before prompting', async () => {
  const unknown = await run(['--not-an-option'])
  expect(unknown.code).toBe(2)
  expect(unknown.stderr).toMatch(/unknown argument --not-an-option/)

  const missing = await run(['--env-path'])
  expect(missing.code).toBe(2)
  expect(missing.stderr).toMatch(/--env-path requires a value/)

  // A newline in --var would otherwise be written verbatim into .env, where the
  // text after it becomes a second assignment the operator never authorized.
  const injection = await run(['--var', 'SAFE\nINJECTED'])
  expect(injection.code).toBe(2)
  expect(injection.stderr).toMatch(/valid environment variable name/)
})

test('the CLI refuses a non-interactive terminal without writing a verifier', async () => {
  const result = await run([])
  expect(result.code).toBe(1)
  expect(result.stderr).toMatch(/must run in an interactive terminal/)
  expect(result.stdout, 'nothing may be written before a password is read').toBe('')
  // The refusal path must not leak a verifier, and cannot have computed one:
  // it is reached before any password exists to hash.
  expect(result.stderr.includes('scrypt$'), 'no verifier may appear in output').toBe(false)
})

test('the CLI writes no file when it refuses', async () => {
  // The refusals above are only safe if they happen before the write. Pointing
  // --env-path at a path inside a directory that does not exist makes any write
  // attempt observable: it would have to create the file, and it cannot.
  const target = fileURLToPath(new URL('../../dist/__no_such_dir__/.env', import.meta.url))
  const result = await run(['--env-path', target])
  expect(result.code).toBe(1)
  await expect(open(target, 'r'), 'the refusal must not have created a file').rejects.toMatchObject(
    {
      code: 'ENOENT',
    },
  )
})

test('the CLI rejects --env-file, which Node itself owns', async () => {
  // Node consumes `--env-file` wherever it appears — after the script path
  // included — preloading that file as dotenv and exiting 9 when it is missing.
  // `--env-file` naming a file this command is about to create was therefore
  // dead on arrival, which is why the flag is `--env-path`.
  //
  // Only the `--env-file=<path>` form is testable, and only over a file that
  // exists: Node passes that spelling through to argv after preloading it, so
  // the CLI gets to refuse it. The space-separated form kills the process before
  // the CLI runs, so there is no CLI behavior there to assert — that gap is the
  // collision itself, not an untested branch.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-login-cli-'))
  try {
    const preloadable = join(dir, 'preloadable.env')
    await writeFile(preloadable, '', 'utf8')
    const result = await run([`--env-file=${preloadable}`])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/--env-file is reserved by Node itself/)
    expect(result.stderr, 'the message must name the replacement').toMatch(/--env-path/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
