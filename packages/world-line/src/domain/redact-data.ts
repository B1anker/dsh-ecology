import { isSensitiveKey, REDACTED, redactText } from './redaction.js'
/** Redact strings without letting text redaction damage JSON delimiters. */
export function redactData<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map((item) => redactData(item)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactData(item),
      ]),
    ) as T
  return value
}
