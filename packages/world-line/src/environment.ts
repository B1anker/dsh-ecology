import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

import { FileError } from './domain/errors.js'

async function readEnvironmentFile(file: string): Promise<NodeJS.ProcessEnv> {
  try {
    return parseEnv(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Never echo parser diagnostics, which may contain secret source text.
    throw new FileError(`cannot read or parse environment file ${file}`)
  }
}

function mergeEnvironment(...layers: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) env[key] = value
    }
  }
  return env
}

/** Runtime overrides for lab/restore-lab/rescue only; never used for official promotion. */
export async function loadExperimentEnvironment(
  official: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv,
  options: { inherit?: boolean; directory?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const file = join(options.directory ?? join(homedir(), '.dsh-wl'), '.env')
  return mergeEnvironment(
    options.inherit === false ? {} : official,
    await readEnvironmentFile(file),
    inherited,
  )
}

/** Load only the selected home's .env, without changing process.env or executing shell code. */
export async function loadDshEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const env = mergeEnvironment(await readEnvironmentFile(join(home, '.env')), inherited)
  // A file's DSH_HOME must not redirect this invocation or any child away from
  // the home chosen by --dsh-home / the inherited environment. Labs override it.
  env.DSH_HOME = home
  return env
}
