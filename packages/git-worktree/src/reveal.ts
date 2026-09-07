import { execFile as execFileCallback } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { GitWorktreeError } from './git.js'

const execFile = promisify(execFileCallback)

export type FileManagerKind = 'finder' | 'explorer' | 'file-manager'

/** Map the host OS to the file-manager label the UI should show. */
export function fileManagerKind(platform: NodeJS.Platform = process.platform): FileManagerKind {
  if (platform === 'darwin') return 'finder'
  if (platform === 'win32') return 'explorer'
  return 'file-manager'
}

/**
 * Open a directory in the host file manager (Finder / Explorer / xdg-open).
 * @param path - absolute directory to reveal.
 */
export async function revealInFileManager(
  path: string,
): Promise<{ path: string; kind: FileManagerKind }> {
  const resolved = await realpath(path).catch(() => {
    throw new GitWorktreeError(`Directory does not exist: ${path}`)
  })
  if (!(await stat(resolved)).isDirectory()) {
    throw new GitWorktreeError(`Not a directory: ${resolved}`)
  }

  const kind = fileManagerKind()
  if (process.platform === 'darwin') {
    await execFile('open', [resolved])
  } else if (process.platform === 'win32') {
    await execFile('explorer', [resolved])
  } else {
    await execFile('xdg-open', [resolved])
  }
  return { path: resolved, kind }
}
