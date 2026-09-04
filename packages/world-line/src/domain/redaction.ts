/**
 * Redaction: invariant 6 — secrets never appear in stdout, reports, diffs, or
 * ordinary manifests.
 *
 * Two layers:
 *
 * - `redactText` scrubs free text (error messages, YAML diagnostics, logs):
 *   URL credentials, provider-prefixed tokens, bearer tokens, and
 *   `key=value` / `key: value` pairs under sensitive key names.
 * - `redactValue` / `redactTree` scrub structured data by key name before it
 *   is persisted into a manifest or rendered into a diff, so a snapshot that
 *   must record a config change never records the secret itself.
 *
 * The rules are deliberately pattern-conservative: 64-hex content hashes,
 * object ids, and ordinary prose must survive untouched.
 */

/** Key fragments that mark a value as sensitive wherever they appear. */
const SENSITIVE_KEY_FRAGMENTS = [
  'api[_-]?key',
  'access[_-]?key',
  'private[_-]?key',
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'bearer',
  'webhook',
]

/** Matches a whole key whose name marks its value sensitive. */
export const SENSITIVE_KEY_RE = new RegExp(
  `^(?:${SENSITIVE_KEY_FRAGMENTS.join('|')})(?:$|[-_.])`,
  'i',
)

/** Matches a key whose name *ends* in a sensitive fragment (`clientSecret`). */
const SENSITIVE_KEY_SUFFIX_RE = new RegExp(`(?:${SENSITIVE_KEY_FRAGMENTS.join('|')})$`, 'i')

/** Replacement text for every masked secret. */
export const REDACTED = '<redacted>'

/** One recognisable secret shape; used for both masking and detection. */
interface SecretShape {
  kind: string
  re: RegExp
  /** Turn one match into masked text (group 1 carries preserved context). */
  replace(match: string, groups: Array<string | undefined>): string
}

/** Every secret shape recognised in free text, in masking order. */
const TEXT_SHAPES: SecretShape[] = [
  {
    // URL credentials: `scheme://user:secret@host` keeps user, drops secret.
    kind: 'url-credentials',
    re: /(\b(?:https?|ftp|wss?|git|ssh|file):\/\/[^/\s:@]+:)[^@\s/]+@/g,
    replace: (_match, groups) => `${groups[0] ?? ''}${REDACTED}@`,
  },
  {
    // Provider-prefixed tokens (GitHub, Slack, Anthropic/OpenAI-ish).
    kind: 'prefixed-token',
    re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}\b|\bsk-[A-Za-z0-9_-]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
    replace: () => REDACTED,
  },
  {
    // `Authorization: Bearer <token>` style headers.
    kind: 'bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    replace: () => REDACTED,
  },
]

/** `key=value` or `key: value` where key is sensitive; value is masked. */
const ASSIGNMENT_RE = new RegExp(
  `(\\b(?:${SENSITIVE_KEY_FRAGMENTS.join('|')})(?:[-_.][A-Za-z0-9_-]+)*\\s*(?::|=)\\s*)(?:["']?)([^\\s,;}]+)`,
  'gi',
)

/** Whether a key name marks its value sensitive (start or end fragment). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) || SENSITIVE_KEY_SUFFIX_RE.test(key)
}

/**
 * Mask one value for structured output. Strings under a sensitive key are
 * fully masked; every other string is scrubbed for embedded secret shapes.
 * Non-string scalars pass through (booleans and numbers are structure, not
 * secrets).
 */
export function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (value === '') return value
  if (isSensitiveKey(key)) return REDACTED
  return redactText(value)
}

/**
 * Deep-redact a parsed YAML/JSON tree, returning a new tree with secret-shaped
 * values masked. Each level passes its key down so `clientSecret`-style names
 * mask fully; every other string is scrubbed for embedded token shapes and
 * URL credentials. Object identity is not preserved.
 */
export function redactTree(value: unknown): unknown {
  return redactNode(value, undefined)
}

function redactNode(value: unknown, key: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((child) => redactNode(child, undefined))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = redactNode(child, childKey)
    }
    return out
  }
  if (typeof value === 'string') {
    return key === undefined ? redactText(value) : redactValue(key, value)
  }
  return value
}

/** Whether a scalar value is an obvious non-secret (boolean/number/null-ish). */
function isPlainScalar(value: string): boolean {
  return /^(?:true|false|null|~|0|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(value)
}

/** Scrub one text buffer for every known secret shape. */
export function redactText(text: string): string {
  let out = text
  for (const shape of TEXT_SHAPES) {
    out = out.replace(shape.re, (_match, ...rest: Array<string | undefined>) =>
      shape.replace(_match, rest.slice(0, -2)),
    )
  }
  out = out.replace(ASSIGNMENT_RE, (_whole, prefix: string, value: string) => {
    if (isPlainScalar(value)) return `${prefix}${value}`
    return `${prefix}${REDACTED}`
  })
  return out
}

/**
 * Detect every secret shape present in one text buffer. Returns the distinct
 * kinds found (empty when the buffer looks clean). Used by the snapshot
 * secret-skip policy: a file this function flags is not persisted to the
 * plaintext vault (crypto vault support lands in Phase 4).
 */
export function detectSecretShapes(text: string): string[] {
  const found = new Set<string>()
  for (const shape of TEXT_SHAPES) {
    shape.re.lastIndex = 0
    if (shape.re.test(text)) found.add(shape.kind)
  }
  for (const match of text.matchAll(ASSIGNMENT_RE)) {
    const value = match[2]
    if (value !== undefined && !isPlainScalar(value)) {
      found.add(
        `sensitive-key-assignment:${match[1]?.trim().split(/[:=]/)[0]?.toLowerCase() ?? 'value'}`,
      )
    }
  }
  return [...found].sort()
}
