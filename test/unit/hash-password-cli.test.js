import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/hash-password.mjs', ...args], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('the hash CLI documents its arguments without requiring a TTY', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^Usage: dsh-web-login-hash/m)
  assert.match(result.stdout, /--env-file <path>/)
  assert.match(result.stdout, /--var <NAME>/)
  assert.equal(result.stderr, '')
})

test('the hash CLI refuses bad arguments before prompting', async () => {
  const unknown = await run(['--not-an-option'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown argument --not-an-option/)

  const missing = await run(['--env-file'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /--env-file requires a value/)

  // Newlines in --var could otherwise become a second .env assignment.
  const injection = await run(['--var', 'SAFE\nINJECTED'])
  assert.equal(injection.code, 2)
  assert.match(injection.stderr, /valid environment variable name/)
})

test('the hash CLI refuses a non-interactive terminal without writing a verifier', async () => {
  const result = await run([])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /must run in an interactive terminal/)
  assert.equal(result.stdout, '')
  assert.ok(!result.stderr.includes('scrypt$'))
})
