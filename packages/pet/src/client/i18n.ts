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
  /** aria-label fallback when the pet has no name yet. */
  defaultPetName: string
  /** Label of the settings section slot. */
  settingsSection: string
  /** Bubble shown while the agent waits for user input. */
  waitingHint: string
  /** Tooltip/aria for the paw button that brings a hidden pet back. */
  restorePet: string
  /** Settings panel: pet appearance picker. */
  appearanceLabel: string
  /** Settings panel: rename input. */
  nameLabel: string
  /** Settings panel: scale slider. */
  scaleLabel: string
  /** Settings panel: show/hide switch. */
  visibleLabel: string
  /** Settings panel: desktop-companion bridge switch. */
  companionLabel: string
  /** Badge marking an imported desktop pet in the appearance picker. */
  desktopPetBadge: string
}

const DICTIONARIES: Record<Locale, Strings> = {
  zh: {
    defaultPetName: 'Mochi',
    settingsSection: '宠物',
    waitingHint: '在等你回复…',
    restorePet: '召回宠物',
    appearanceLabel: '形象',
    nameLabel: '名字',
    scaleLabel: '大小',
    visibleLabel: '显示宠物',
    companionLabel: '桌面伴侣',
    desktopPetBadge: '桌面',
  },
  en: {
    defaultPetName: 'Mochi',
    settingsSection: 'Pet',
    waitingHint: 'Waiting for you…',
    restorePet: 'Bring the pet back',
    appearanceLabel: 'Appearance',
    nameLabel: 'Name',
    scaleLabel: 'Size',
    visibleLabel: 'Show pet',
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
