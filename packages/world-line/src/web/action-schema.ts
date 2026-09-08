import { UsageError } from '../domain/errors.js'

type Rule = 'string' | 'boolean' | 'strings' | 'object'
type Definition = {
  required?: Record<string, Rule>
  optional?: Record<string, Rule>
  write: boolean
}
const options = {
  sourceId: 'string',
  keep: 'boolean',
  interactive: 'boolean',
  allowScripts: 'boolean',
  promote: 'boolean',
  acceptInconclusive: 'boolean',
  restart: 'boolean',
} as const
const id = { id: 'string' } as const
export const actionDefinitions: Record<string, Definition> = {
  'cache-prune': { optional: { runtimeStopped: 'boolean' }, write: true },
  'cache-migrate': { required: id, write: true },
  'deployment-status': { write: false },
  'deployment-stage': { required: id, write: true },
  'deployment-activate': { required: id, write: true },
  'deployment-rollback': { write: true },
  'deployment-config': { required: { enabled: 'boolean', threshold: 'string' }, write: true },
  'deployment-service': {
    required: { operation: 'string' },
    optional: { breakStale: 'boolean' },
    write: true,
  },
  'version-matrix': {
    required: { versions: 'strings' },
    optional: { sourceId: 'string' },
    write: true,
  },
  'upgrade-results': { write: false },
  'upgrade-policy': {
    required: id,
    optional: { enabled: 'boolean', hours: 'string' },
    write: true,
  },
  'upgrade-check': { required: id, write: true },
  'environment-export': { required: { ...id, snapshotId: 'string' }, write: false },
  'environment-import': {
    required: { bundleText: 'string' },
    optional: { sourceId: 'string', requiredFiles: 'object' },
    write: true,
  },
  investigations: { write: false },
  'investigation-create': {
    required: { kind: 'string' },
    optional: { sourceId: 'string', good: 'string', bad: 'string' },
    write: true,
  },
  'investigation-preview': { required: id, write: true },
  'investigation-run': { required: id, optional: { automatic: 'boolean' }, write: true },
  'investigation-answer': {
    required: { ...id, revision: 'string', verdict: 'string' },
    write: true,
  },
  'investigation-skip-interrupted': {
    required: id,
    optional: { breakStale: 'boolean' },
    write: true,
  },
  'artifact-cleanup-preview': { required: id, write: false },
  'artifact-cleanup-apply': { required: { ...id, revision: 'string' }, write: true },
  'recovery-list': { required: id, write: false },
  'recovery-apply': {
    required: {
      ...id,
      recordId: 'string',
      transaction: 'boolean',
      runtimeStopped: 'boolean',
      breakStale: 'boolean',
    },
    optional: { labId: 'string' },
    write: true,
  },
  'gc-records': { required: id, write: false },
  storage: { required: id, write: false },
  'storage-prune-preview': { required: id, write: false },
  'storage-prune-apply': { required: { ...id, revision: 'string' }, write: true },
  'gc-purge': { required: { ...id, recordId: 'string' }, write: true },
  'gc-preview': { required: id, write: false },
  'gc-apply': { required: { ...id, revision: 'string' }, write: true },
  'gc-restore': { required: { ...id, recordId: 'string' }, write: true },
  'lab-diff': { required: id, write: false },
  composition: { required: id, write: false },
  'snapshot-list': { required: id, write: false },
  'snapshot-compare': { required: { from: 'object', to: 'object' }, write: false },
  'lab-add': { required: { spec: 'string' }, optional: options, write: true },
  'lab-update': { required: { spec: 'string' }, optional: options, write: true },
  'lab-remove': { required: { spec: 'string' }, optional: options, write: true },
  'lab-config-apply': { required: { text: 'string' }, optional: options, write: true },
  report: { required: id, optional: { lineId: 'string' }, write: false },
  compare: { required: { from: 'string', to: 'string' }, write: false },
  'snapshot-detail': { required: { ...id, snapshotId: 'string' }, write: false },
  snapshot: { required: { ...id, label: 'string' }, write: true },
  create: {
    required: { alias: 'string' },
    optional: {
      from: 'string',
      snapshotId: 'string',
      clean: 'boolean',
      plugins: 'strings',
      copyPluginConfig: 'boolean',
    },
    write: true,
  },
  jobs: { optional: { before: 'string' }, write: false },
  job: { required: id, write: false },
  doctor: { write: false },
  restore: {
    optional: {
      snapshotId: 'string',
      lastKnownGood: 'boolean',
      promote: 'boolean',
      restart: 'boolean',
      keep: 'boolean',
      acceptInconclusive: 'boolean',
    },
    write: true,
  },
  'lab-status': { required: id, write: false },
  'lab-verify': { required: id, optional: { interactive: 'boolean' }, write: true },
  promote: {
    required: id,
    optional: { restart: 'boolean', acceptInconclusive: 'boolean', acceptReview: 'boolean' },
    write: true,
  },
  start: { required: id, write: true },
  restart: { required: id, write: true },
  stop: { required: id, write: true },
  destroy: { required: id, write: true },
  default: { required: id, write: true },
  alias: { required: { ...id, alias: 'string' }, write: true },
  'rescue-enter': { required: id, write: false },
  'rescue-list': { write: false },
  'rescue-plugins': { write: false },
  'clean-plugins': { optional: { id: 'string' }, write: false },
  'rescue-start': { optional: { allow: 'strings' }, write: true },
  'rescue-stop': { required: id, write: true },
  'merge-preview': { required: id, write: false },
  'merge-commit': { required: id, write: true },
  'merge-prepare': {
    required: { ...id, revision: 'string', plugins: 'strings', includeConfig: 'boolean' },
    write: true,
  },
}
export function validateAction(body: Record<string, unknown>): string {
  if (typeof body.action !== 'string' || !Object.hasOwn(actionDefinitions, body.action))
    throw new UsageError('未知操作')
  const definition = actionDefinitions[body.action]!
  const fields = { requestId: 'string' as Rule, ...definition.optional, ...definition.required }
  for (const key of Object.keys(body))
    if (key !== 'action' && !Object.hasOwn(fields, key)) throw new UsageError(`不支持的参数 ${key}`)
  for (const [key, rule] of Object.entries(fields)) {
    const value = body[key]
    if (value === undefined && !Object.hasOwn(definition.required ?? {}, key)) continue
    const valid =
      rule === 'strings'
        ? Array.isArray(value) &&
          value.length <= 200 &&
          value.every((x) => typeof x === 'string' && x.length <= 4096)
        : rule === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === rule
    if (
      !valid ||
      (typeof value === 'string' &&
        (!value.trim() ||
          value.length > (key === 'bundleText' ? 32 * 1024 * 1024 : key === 'text' ? 65536 : 4096)))
    )
      throw new UsageError(`无效参数 ${key}`)
  }
  return body.action
}
