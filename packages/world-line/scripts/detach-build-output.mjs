// pnpm file: packages can hard-link dist files into old installations. Break
// those links before tsc overwrites files, so a build cannot mutate other labs.

import { constants } from 'node:fs'
import { copyFile, lstat, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export async function detachBuildOutput(directory) {
  for (const entry of await readdir(directory).catch((e) => {
    if (e.code === 'ENOENT') return []
    throw e
  })) {
    const path = join(directory, entry),
      info = await lstat(path)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) await detachBuildOutput(path)
    else if (info.isFile() && info.nlink > 1) {
      const temporary = `${path}.detach-${process.pid}`
      try {
        await copyFile(path, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await detachBuildOutput(fileURLToPath(new URL('../dist', import.meta.url)))
