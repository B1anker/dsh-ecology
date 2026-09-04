/**
 * Self-contained zh/en strings.
 *
 * The shell has a `locale` service, but its client-side contract is not part
 * of the M0-verified surface (see host-types.ts), so injecting it would bind
 * the plugin to a guess. For the MVP the dictionary ships inside the bundle
 * and the locale comes from `navigator.language` — anything starting with
 * `zh` gets Chinese, everything else English. When the locale contract is
 * verified, this module is the single seam to rewire.
 *
 * @module @seaveyon/dsh-pet/client/i18n
 */

export type Locale = 'zh' | 'en'

export interface Strings {
  /** Label of the settings section slot. */
  settingsSection: string
  /** Settings panel: pet appearance picker. */
  appearanceLabel: string
  /** Settings panel: note that the pet itself lives on the desktop. */
  desktopHint: string
  /** Settings panel: rename input. */
  nameLabel: string
  /** Settings panel: desktop-companion bridge switch. */
  companionLabel: string
  /** Badge marking an imported desktop pet in the appearance picker. */
  desktopPetBadge: string
}

const DICTIONARIES: Record<Locale, Strings> = {
  zh: {
    settingsSection: '宠物',
    appearanceLabel: '形象',
    desktopHint: '宠物显示在桌面 App 里，不在本页面上。',
    nameLabel: '名字',
    companionLabel: '桌面伴侣',
    desktopPetBadge: '桌面',
  },
  en: {
    settingsSection: 'Pet',
    appearanceLabel: 'Appearance',
    desktopHint: 'The pet lives in the desktop app, not on this page.',
    nameLabel: 'Name',
    companionLabel: 'Desktop companion',
    desktopPetBadge: 'Desktop',
  },
}

/**
 * Pick a locale from a BCP-47 tag. Only the `zh` prefix matters; the runner-
 * up is always English, so unknown tags degrade gracefully.
 */
export function detectLocale(language: string | undefined): Locale {
  return language !== undefined && language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The runtime strings for this page load. */
export function getStrings(locale: Locale = detectLocale(navigator.language)): Strings {
  return DICTIONARIES[locale]
}
