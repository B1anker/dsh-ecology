/**
 * Tolerant readers: ENOENT maps to `undefined` / `[]`, parse failures and
 * other I/O errors still throw.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from '@rstest/core'

import { readdirIfExists, readJsonIfExists, readTextIfExists } from '../../src/fs/read-json.js'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wl-test-'))
}

describe('readJsonIfExists', () => {
  test('parses an existing file and returns undefined for a missing one', async () => {
    const dir = await tempDir()
    try {
      const file = join(dir, 'state.json')
      await writeFile(file, '{"version":1}')
      await expect(readJsonIfExists<{ version: number }>(file)).resolves.toEqual({ version: 1 })
      await expect(readJsonIfExists(join(dir, 'absent.json'))).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rethrows parse failures and non-ENOENT errors', async () => {
    const dir = await tempDir()
    try {
      const file = join(dir, 'corrupt.json')
      await writeFile(file, 'not json')
      await expect(readJsonIfExists(file)).rejects.toThrow(SyntaxError)
      await expect(readJsonIfExists(dir)).rejects.toMatchObject({ code: 'EISDIR' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readTextIfExists', () => {
  test('reads an existing file and returns undefined for a missing one', async () => {
    const dir = await tempDir()
    try {
      const file = join(dir, 'note.txt')
      await writeFile(file, 'hello\n')
      await expect(readTextIfExists(file)).resolves.toBe('hello\n')
      await expect(readTextIfExists(join(dir, 'absent.txt'))).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readdirIfExists', () => {
  test('lists an existing directory and returns [] for a missing one', async () => {
    const dir = await tempDir()
    try {
      await mkdir(join(dir, 'sub'))
      await writeFile(join(dir, 'sub', 'a.json'), '{}')
      await writeFile(join(dir, 'sub', 'b.json'), '{}')
      await expect(readdirIfExists(join(dir, 'sub'))).resolves.toEqual(['a.json', 'b.json'])
      await expect(readdirIfExists(join(dir, 'absent'))).resolves.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rethrows non-ENOENT errors', async () => {
    const dir = await tempDir()
    try {
      const file = join(dir, 'plain.txt')
      await writeFile(file, 'x')
      await expect(readdirIfExists(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const locked = join(dir, 'locked')
        await mkdir(locked)
        await chmod(locked, 0o000)
        await expect(readdirIfExists(locked)).rejects.toMatchObject({ code: 'EACCES' })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
