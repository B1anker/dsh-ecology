/**
 * Tolerant readers for state that may legitimately be absent: a missing
 * file or directory (ENOENT) maps to `undefined` / `[]`, while parse
 * failures and every other I/O error still throw.
 */

import { readdir, readFile } from 'node:fs/promises'

/** Read and JSON-parse `path`; `undefined` when the file does not exist. */
export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read `path` as UTF-8 text; `undefined` when the file does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** List `path`; an empty list when the directory does not exist. */
export async function readdirIfExists(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
