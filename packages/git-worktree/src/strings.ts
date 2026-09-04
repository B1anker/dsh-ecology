import { useSyncExternalStore } from 'react'
import type { LocaleService, Translate } from './client-contracts.js'
import { DICTS, LOCALE_NS, type WorktreeCopy } from './locales.js'

function interpolate(
  template: string,
  params: Record<string, string | number> | undefined,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    String(params?.[name] ?? `{${name}}`),
  )
}

function fallbackTranslate(
  active: string,
  key: keyof WorktreeCopy,
  params?: Record<string, string | number>,
): string {
  const copy = active.toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en
  return interpolate(copy[key] ?? DICTS.en[key] ?? key, params)
}

function translate(locale: LocaleService | undefined, active: string): Translate {
  return (key, params) => {
    const translated = locale?.bind(LOCALE_NS)(key, params)
    return translated === undefined || translated === key
      ? fallbackTranslate(active, key, params)
      : translated
  }
}

export function serviceTranslate(locale: LocaleService | undefined): Translate {
  return translate(locale, locale?.getSnapshot().active ?? navigator.language)
}

/** Keep custom-mounted UI in sync with the shell language selector. */
export function useStrings(locale: LocaleService | undefined): Translate {
  const active = useSyncExternalStore(
    (listener) => locale?.subscribe(listener) ?? (() => {}),
    () => locale?.getSnapshot().active ?? navigator.language,
    () => navigator.language,
  )
  return translate(locale, active)
}
