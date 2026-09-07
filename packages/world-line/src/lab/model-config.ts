import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

import { FileError } from '../domain/errors.js'
import { writeFileAtomic } from '../fs/atomic.js'

const MODEL_SETTINGS = ['llm-pi-ai', 'llm-deepseek', 'agent-default-model'] as const
type Mapping = Record<string, unknown>

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readMapping(home: string, name: string): Promise<Mapping> {
  try {
    const parsed: unknown = load(await readFile(join(home, name), 'utf8'))
    if (parsed === undefined || parsed === null) return {}
    if (!isMapping(parsed)) throw new Error('not a mapping')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // YAML diagnostics can echo credentials; report the role, never the input.
    throw new FileError(`cannot read model configuration from ${name}`)
  }
}

/** Existing mirror values win, including explicit empty/null values. */
function inheritMissing(source: Mapping, target: Mapping): Mapping {
  return Object.fromEntries(
    [...new Set([...Object.keys(source), ...Object.keys(target)])].map((key) => {
      if (!Object.hasOwn(target, key)) return [key, source[key]]
      return [
        key,
        isMapping(source[key]) && isMapping(target[key])
          ? inheritMissing(source[key], target[key])
          : target[key],
      ]
    }),
  )
}

function credentialSections(document: Mapping): { refs: Mapping; records: Mapping } {
  if (Object.keys(document).length === 0) return { refs: {}, records: {} }
  if (
    document.version !== 1 ||
    (document.refs != null && !isMapping(document.refs)) ||
    (document.records != null && !isMapping(document.records))
  ) {
    throw new FileError('cannot inherit API keys: expected credentials document version 1')
  }
  return {
    refs: (document.refs as Mapping | undefined) ?? {},
    records: (document.records as Mapping | undefined) ?? {},
  }
}

/** Capture model settings and API keys, never browser sessions or OAuth grants. */
export async function inheritModelConfiguration(
  sourceHome: string,
  targetHome: string,
  options: { apiKeys?: boolean; allSettings?: boolean } = {},
): Promise<void> {
  const sourceSettings = await readMapping(sourceHome, 'settings.yaml')
  const selected = options.allSettings
    ? sourceSettings
    : Object.fromEntries(
        MODEL_SETTINGS.filter((key) => Object.hasOwn(sourceSettings, key)).map((key) => [
          key,
          sourceSettings[key],
        ]),
      )
  const existingSettings = await readMapping(targetHome, 'settings.yaml')
  const merged = inheritMissing(selected, existingSettings)
  const settings = options.allSettings ? rebaseSettings(merged, sourceHome, targetHome) : merged

  // Prepare all input before writing either file. A malformed secret document
  // must not leave half of a configuration migration behind.
  let credentials: Mapping | undefined
  if (options.apiKeys !== false) {
    const source = credentialSections(await readMapping(sourceHome, '.credentials.yaml'))
    const target = credentialSections(await readMapping(targetHome, '.credentials.yaml'))
    const referenced = new Set<string>()
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect)
        return
      }
      if (!isMapping(value)) return
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'apiKeyEnv' && typeof entry === 'string') referenced.add(entry)
        else collect(entry)
      }
    }
    collect(selected)
    const refs = Object.fromEntries(
      Object.entries(source.refs).filter(
        ([name, value]) =>
          (options.allSettings || referenced.has(name) || /(?:^|_)API_KEY$/.test(name)) &&
          typeof value === 'string' &&
          value.length > 0,
      ),
    )
    const records = Object.fromEntries(
      Object.entries(source.records).filter(
        ([, value]) => isMapping(value) && value.kind === 'api-key',
      ),
    )
    if (Object.keys(refs).length || Object.keys(records).length) {
      credentials = {
        version: 1,
        refs: { ...refs, ...target.refs },
        records: { ...records, ...target.records },
      }
    }
  }
  if (Object.keys(selected).length)
    await writeFileAtomic(join(targetHome, 'settings.yaml'), dump(settings), { mode: 0o600 })
  if (credentials)
    await writeFileAtomic(join(targetHome, '.credentials.yaml'), dump(credentials), { mode: 0o600 })
}

function rebaseSettings(value: Mapping, source: string, target: string): Mapping {
  const rewrite = (entry: unknown): unknown => {
    if (typeof entry === 'string' && (entry === target || entry.startsWith(`${target}/`)))
      return entry
    if (typeof entry === 'string' && (entry === source || entry.startsWith(`${source}/`)))
      return target + entry.slice(source.length)
    if (Array.isArray(entry)) return entry.map(rewrite)
    if (isMapping(entry))
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, rewrite(item)]))
    return entry
  }
  return rewrite(value) as Mapping
}
