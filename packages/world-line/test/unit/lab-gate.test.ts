import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import { UsageError } from '../../src/domain/errors.js'
import { pnpmCandidates, requirePnpm } from '../../src/lab/gate.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pnpm gate', () => {
  it('walks PATH in the platform dialect', () => {
    expect(pnpmCandidates('/usr/bin::/opt/pnpm', 'darwin')).toEqual([
      '/usr/bin/pnpm',
      '/opt/pnpm/pnpm',
    ])
    // Windows: `;` separates entries and `:` belongs to the drive letter.
    // The old `:` split turned `C:\tools` into `C` and `\tools`.
    expect(pnpmCandidates('C:\\tools;;D:\\pnpm\\bin', 'win32')).toEqual([
      'C:\\tools\\pnpm.cmd',
      'C:\\tools\\pnpm.exe',
      'C:\\tools\\pnpm',
      'D:\\pnpm\\bin\\pnpm.cmd',
      'D:\\pnpm\\bin\\pnpm.exe',
      'D:\\pnpm\\bin\\pnpm',
    ])
    expect(pnpmCandidates('', 'linux')).toEqual([])
  })

  it('finds an executable pnpm on PATH and refuses a non-executable one', () => {
    const empty = mkdtempSync(join(tmpdir(), 'wl-gate-empty-'))
    const bin = mkdtempSync(join(tmpdir(), 'wl-gate-bin-'))
    dirs.push(empty, bin)
    const pnpm = join(bin, 'pnpm')
    writeFileSync(pnpm, '#!/bin/sh\n')
    chmodSync(pnpm, 0o644)
    expect(() => requirePnpm({ PATH: `${empty}:${bin}` }, 'darwin')).toThrow(UsageError)

    chmodSync(pnpm, 0o755)
    expect(requirePnpm({ PATH: `${empty}:${bin}` }, 'darwin')).toEqual({ path: pnpm })
    expect(() => requirePnpm({}, 'darwin')).toThrow(/no pnpm executable found on PATH/)
  })
})
